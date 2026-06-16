import json
import os
import queue
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel


PORT = int(os.environ.get("PORT", "8080"))
DB_PATH = os.environ.get("DB_PATH", "/data/agents.db")
DEFAULT_MODEL = os.environ.get("DEFAULT_MODEL", "openclaw/default")
OPENCLAW_BASE_URL = os.environ.get("OPENCLAW_BASE_URL", "http://127.0.0.1:18789/v1")
OPENCLAW_API_KEY = (
    os.environ.get("OPENCLAW_API_KEY")
    or os.environ.get("OPENCLAW_GATEWAY_TOKEN")
    or os.environ.get("OPENCLAW_GATEWAY_PASSWORD")
    or ""
)
OPENCLAW_REQUEST_TIMEOUT_SECONDS = float(os.environ.get("OPENCLAW_REQUEST_TIMEOUT_SECONDS", "600"))
RUNTIME_API_KEY = os.environ.get("RUNTIME_API_KEY")
OPENCLAW_CONFIG_PATH = os.environ.get(
    "OPENCLAW_CONFIG_PATH",
    str(Path(os.environ.get("HOME", "/data")) / ".openclaw" / "openclaw.json"),
)
LEGACY_OPENCLAW_MANAGED_MCP_PATH = os.environ.get(
    "OPENCLAW_MANAGED_MCP_PATH",
    str(Path(DB_PATH).parent / "openclaw-managed-mcp-servers.json"),
)


app = FastAPI(title="OpenClaw Anthropic Managed Agents bridge")
state_lock = threading.Lock()
config_lock = threading.RLock()
run_queues: dict[str, "queue.Queue[dict[str, Any]]"] = {}
active_runs: dict[str, bool] = {}
pending_prompts: dict[str, "queue.Queue[str]"] = {}
abort_flags: dict[str, threading.Event] = {}
TERMINAL_EVENTS = {"session.status_idle", "session.error"}
BRIDGE_CONFIG_KEY = "_litellmAgentPlatform"
MANAGED_MCP_CONFIG_KEY = "managedMcpServers"
PERSISTED_MCP_SECRET_FIELDS = {
    "authorization_token",
    "headers",
    "auth",
    "oauth",
    "env",
    "clientCert",
    "clientKey",
}


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def db() -> sqlite3.Connection:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS agents (
              id TEXT PRIMARY KEY,
              name TEXT,
              description TEXT,
              model TEXT,
              system TEXT,
              tools TEXT,
              mcp_servers TEXT,
              metadata TEXT,
              created_at INTEGER,
              updated_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS environments (
              id TEXT PRIMARY KEY,
              name TEXT,
              config TEXT,
              description TEXT,
              created_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS sessions (
              id TEXT PRIMARY KEY,
              agent_id TEXT,
              environment_id TEXT,
              title TEXT,
              status TEXT,
              created_at INTEGER,
              updated_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              session_id TEXT,
              event TEXT,
              data TEXT,
              created_at INTEGER
            );
            """
        )


init_db()


class CreateAgentRequest(BaseModel):
    name: str | None = None
    model: str | dict[str, Any] | None = None
    system: str | None = None
    system_prompt: str | None = None
    description: str | None = None
    tools: list[dict[str, Any]] | None = None
    mcp_servers: list[dict[str, Any]] | None = None
    metadata: dict[str, Any] | None = None


class CreateEnvironmentRequest(BaseModel):
    name: str | None = None
    config: dict[str, Any] | None = None
    description: str | None = None


class CreateSessionRequest(BaseModel):
    agent: str
    environment_id: str | None = None
    title: str | None = None
    metadata: dict[str, Any] | None = None


class SendEventsRequest(BaseModel):
    events: list[dict[str, Any]]


@app.middleware("http")
async def require_runtime_key(request: Request, call_next):
    if request.url.path == "/health":
        return await call_next(request)
    api_key = request.headers.get("x-api-key")
    if RUNTIME_API_KEY:
        if api_key != RUNTIME_API_KEY:
            return JSONResponse(
                status_code=401,
                content={"error": "invalid runtime api key"},
            )
    elif not api_key:
        return JSONResponse(
            status_code=401,
            content={"error": "x-api-key is required"},
        )
    return await call_next(request)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "openclaw_base_url": normalized_openclaw_base_url(),
        "openclaw_api_key": bool(OPENCLAW_API_KEY),
    }


@app.get("/ready")
def ready() -> dict[str, Any]:
    return {
        "ok": True,
        "openclaw": check_openclaw(),
        "openclaw_base_url": normalized_openclaw_base_url(),
        "openclaw_api_key": bool(OPENCLAW_API_KEY),
    }


@app.get("/v1/models")
def list_models() -> dict[str, Any]:
    try:
        return openclaw_get("/models")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def model_id(model: Any) -> str:
    if isinstance(model, str) and model.strip():
        return model.strip()
    if isinstance(model, dict) and isinstance(model.get("id"), str):
        return model["id"].strip()
    return DEFAULT_MODEL


def json_dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"))


def parse_json(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


def config_signature(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def openclaw_config_path() -> Path:
    return Path(OPENCLAW_CONFIG_PATH)


def legacy_managed_mcp_path() -> Path:
    return Path(LEGACY_OPENCLAW_MANAGED_MCP_PATH)


def read_json_file(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def read_openclaw_config(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"OpenClaw config is not valid JSON: {path}") from exc
    if not isinstance(value, dict):
        raise RuntimeError("OpenClaw config must be a JSON object")
    return value


def write_json_file(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp-{uuid.uuid4().hex}")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def stored_managed_mcp_names(config: dict[str, Any]) -> set[str]:
    bridge_config = config.get(BRIDGE_CONFIG_KEY)
    if isinstance(bridge_config, dict):
        names = bridge_config.get(MANAGED_MCP_CONFIG_KEY)
        if isinstance(names, list):
            return {name for name in names if isinstance(name, str)}
    legacy_names = read_json_file(legacy_managed_mcp_path(), [])
    if isinstance(legacy_names, list):
        return {name for name in legacy_names if isinstance(name, str)}
    return set()


def store_managed_mcp_names(config: dict[str, Any], names: set[str]) -> None:
    bridge_config = config.setdefault(BRIDGE_CONFIG_KEY, {})
    if not isinstance(bridge_config, dict):
        bridge_config = {}
        config[BRIDGE_CONFIG_KEY] = bridge_config
    bridge_config[MANAGED_MCP_CONFIG_KEY] = sorted(names)


def server_name(server: dict[str, Any]) -> str:
    for key in ("name", "server_id", "id"):
        value = server.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    raise ValueError("mcp server entry requires name, server_id, or id")


def transport_for_server(server: dict[str, Any]) -> str:
    transport = server.get("transport")
    if isinstance(transport, str) and transport.strip():
        return transport.strip()
    server_type = server.get("type")
    if isinstance(server_type, str) and server_type in {"sse", "streamable-http"}:
        return server_type
    url = str(server.get("url") or "").rstrip("/")
    if url.endswith("/sse"):
        return "sse"
    return "streamable-http"


def allowed_tool_names(server: dict[str, Any]) -> list[str]:
    value = server.get("allowed_tools") or server.get("allowedTools")
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def openclaw_mcp_server(server: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    name = server_name(server)
    secret_fields = sorted(field for field in PERSISTED_MCP_SECRET_FIELDS if field in server)
    if secret_fields:
        raise ValueError(
            f"mcp server {name} cannot include credential fields: {', '.join(secret_fields)}"
        )
    result: dict[str, Any] = {}
    for key in (
        "command",
        "args",
        "url",
        "transport",
        "timeout",
        "connectTimeout",
        "connectionTimeoutMs",
        "requestTimeoutMs",
        "sslVerify",
        "supportsParallelToolCalls",
        "enabled",
        "toolFilter",
    ):
        if key in server:
            result[key] = server[key]
    if "url" in result:
        result["transport"] = transport_for_server(server)
    if "command" not in result and "url" not in result:
        raise ValueError(f"mcp server {name} requires url or command")

    allowed_tools = allowed_tool_names(server)
    if allowed_tools and "toolFilter" not in result:
        result["toolFilter"] = {"include": allowed_tools}
    return name, result


def agent_mcp_servers(row: sqlite3.Row) -> dict[str, dict[str, Any]]:
    desired: dict[str, dict[str, Any]] = {}
    servers = parse_json(row["mcp_servers"], [])
    if not isinstance(servers, list):
        raise ValueError(f"agent {row['id']} mcp_servers must be a list")
    for server in servers:
        if not isinstance(server, dict):
            raise ValueError(f"agent {row['id']} has invalid mcp server entry")
        name, config = openclaw_mcp_server(server)
        existing = desired.get(name)
        if existing is not None and config_signature(existing) != config_signature(config):
            raise ValueError(f"conflicting MCP server config for {name}")
        desired[name] = config
    return desired


def validate_mcp_servers_input(mcp_servers: list[dict[str, Any]] | None) -> None:
    if mcp_servers is None:
        return
    if not isinstance(mcp_servers, list):
        raise HTTPException(status_code=400, detail="mcp_servers must be a list")
    for server in mcp_servers:
        if not isinstance(server, dict):
            raise HTTPException(status_code=400, detail="mcp_servers entries must be objects")
        try:
            openclaw_mcp_server(server)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


def sync_openclaw_mcp_config_or_400(agent_row: sqlite3.Row) -> None:
    try:
        sync_openclaw_mcp_config(agent_row)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def ensure_mcp_tool_policy(config: dict[str, Any], has_mcp_servers: bool) -> None:
    if not has_mcp_servers:
        return
    tools = config.setdefault("tools", {})
    if not isinstance(tools, dict):
        return
    sandbox = tools.setdefault("sandbox", {})
    if not isinstance(sandbox, dict):
        return
    sandbox_tools = sandbox.setdefault("tools", {})
    if not isinstance(sandbox_tools, dict):
        return
    also_allow = sandbox_tools.setdefault("alsoAllow", [])
    if isinstance(also_allow, list) and "bundle-mcp" not in also_allow:
        also_allow.append("bundle-mcp")


def sync_openclaw_mcp_config(agent_row: sqlite3.Row) -> None:
    with config_lock:
        desired = agent_mcp_servers(agent_row)
        config_path = openclaw_config_path()
        config = read_openclaw_config(config_path)
        mcp = config.setdefault("mcp", {})
        if not isinstance(mcp, dict):
            raise RuntimeError("OpenClaw config mcp must be an object")
        servers = mcp.setdefault("servers", {})
        if not isinstance(servers, dict):
            raise RuntimeError("OpenClaw config mcp.servers must be an object")

        previous_names = stored_managed_mcp_names(config)
        for name in previous_names - set(desired):
            servers.pop(name, None)
        servers.update(desired)
        store_managed_mcp_names(config, set(desired))
        ensure_mcp_tool_policy(config, bool(desired))
        write_json_file(config_path, config)


def row_to_agent(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "type": "agent",
        "name": row["name"],
        "description": row["description"],
        "model": {"id": row["model"] or DEFAULT_MODEL},
        "system": row["system"] or "",
        "tools": parse_json(row["tools"], []),
        "mcp_servers": parse_json(row["mcp_servers"], []),
        "metadata": parse_json(row["metadata"], None),
        "version": 1,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def row_to_environment(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "type": "environment",
        "name": row["name"],
        "config": parse_json(row["config"], {}),
        "description": row["description"],
        "created_at": row["created_at"],
    }


def row_to_session(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "type": "session",
        "agent": row["agent_id"],
        "environment_id": row["environment_id"],
        "title": row["title"],
        "status": row["status"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def get_agent(agent_id: str) -> sqlite3.Row | None:
    with db() as conn:
        return conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()


def get_session(session_id: str) -> sqlite3.Row | None:
    with db() as conn:
        return conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()


def store_event(session_id: str, event: str, data: dict[str, Any]) -> dict[str, Any]:
    if "id" not in data:
        data = {"id": new_id("sevt"), **data}
    with db() as conn:
        cursor = conn.execute(
            "INSERT INTO events (session_id, event, data, created_at) VALUES (?, ?, ?, ?)",
            (session_id, event, json_dumps(data), now_ms()),
        )
        event_id = cursor.lastrowid
    return {"id": event_id, "event": event, "data": data}


def enqueue_event(session_id: str, record: dict[str, Any]) -> None:
    q = run_queues.get(session_id)
    if q:
        q.put(record)


def append_event(session_id: str, event: str, data: dict[str, Any]) -> dict[str, Any]:
    record = store_event(session_id, event, data)
    with state_lock:
        enqueue_event(session_id, record)
    return record


def append_event_if_not_aborted(
    session_id: str,
    event: str,
    data: dict[str, Any],
    abort_flag: threading.Event,
) -> bool:
    with state_lock:
        if abort_flag.is_set():
            return False
        enqueue_event(session_id, store_event(session_id, event, data))
    return True


def set_session_status(session_id: str, status: str) -> None:
    with db() as conn:
        conn.execute(
            "UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?",
            (status, now_ms(), session_id),
        )


def set_session_status_if_not_aborted(
    session_id: str,
    status: str,
    abort_flag: threading.Event,
) -> bool:
    with state_lock:
        if abort_flag.is_set():
            return False
        set_session_status(session_id, status)
    return True


def list_events(session_id: str) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            "SELECT id, event, data FROM events WHERE session_id = ? ORDER BY id ASC",
            (session_id,),
        ).fetchall()
    return [
        {"id": row["id"], "event": row["event"], "data": parse_json(row["data"], {})}
        for row in rows
    ]


def latest_turn_from_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for index in range(len(events) - 1, -1, -1):
        if events[index]["event"] == "user.message":
            return events[index:]
    return events


def replay_window_from_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for index in range(len(events) - 1, -1, -1):
        if events[index]["event"] in TERMINAL_EVENTS:
            if index == len(events) - 1:
                return latest_turn_from_events(events)
            return events[index + 1 :]
    for index, event in enumerate(events):
        if event["event"] == "user.message":
            return events[index:]
    return events


def has_interrupt(events: list[dict[str, Any]]) -> bool:
    return any(event.get("type") == "user.interrupt" for event in events)


def drain_queue(input_queue: "queue.Queue[Any]") -> None:
    while True:
        try:
            input_queue.get_nowait()
        except queue.Empty:
            break


def request_abort(session_id: str) -> dict[str, Any]:
    with state_lock:
        abort_flag = abort_flags.setdefault(session_id, threading.Event())
        abort_flag.set()
        pending = pending_prompts.setdefault(session_id, queue.Queue())
        drain_queue(pending)
        record = store_event(
            session_id,
            "session.error",
            {"error": {"message": "session abort requested"}},
        )
        enqueue_event(session_id, record)
        set_session_status(session_id, "error")
        q = run_queues.get(session_id)
    if q:
        q.put({"event": "__done__", "data": {}})
    return {"aborted": True}


def user_text(events: list[dict[str, Any]]) -> str:
    chunks: list[str] = []
    for event in events:
        if event.get("type") != "user.message":
            continue
        content = event.get("content")
        if isinstance(content, str):
            chunks.append(content)
        elif isinstance(content, list):
            for item in content:
                if isinstance(item, str):
                    chunks.append(item)
                elif isinstance(item, dict) and item.get("type") == "text":
                    chunks.append(str(item.get("text") or ""))
    return "\n".join(chunk for chunk in chunks if chunk).strip()


def user_message_data(events: list[dict[str, Any]]) -> dict[str, Any]:
    for event in events:
        if event.get("type") != "user.message":
            continue
        return {key: value for key, value in event.items() if key != "type"}
    return {"content": [{"type": "text", "text": user_text(events)}]}


def clip(text: Any, limit: int = 20_000) -> str:
    value = text if isinstance(text, str) else json_dumps(text)
    if len(value) <= limit:
        return value
    return value[:limit] + f"\n... truncated {len(value) - limit} chars"


def normalized_openclaw_base_url() -> str:
    value = (OPENCLAW_BASE_URL or "http://127.0.0.1:18789/v1").strip().rstrip("/")
    for suffix in ("/chat/completions", "/responses", "/embeddings", "/models"):
        if value.endswith(suffix):
            value = value[: -len(suffix)]
    if not value.endswith("/v1"):
        value = f"{value}/v1"
    return value


def openclaw_url(path: str) -> str:
    return f"{normalized_openclaw_base_url()}/{path.lstrip('/')}"


def openclaw_headers(
    session_id: str | None = None,
    backend_model: str | None = None,
) -> dict[str, str]:
    headers = {"content-type": "application/json"}
    if OPENCLAW_API_KEY:
        headers["authorization"] = f"Bearer {OPENCLAW_API_KEY}"
    if session_id:
        headers["x-openclaw-session-key"] = session_id
    if backend_model:
        headers["x-openclaw-model"] = backend_model
    return headers


def is_openclaw_agent_target(model: str) -> bool:
    return model == "openclaw" or model.startswith("openclaw/") or model.startswith("openclaw:")


def openclaw_request_target(agent_row: sqlite3.Row) -> tuple[str, str | None]:
    model = agent_row["model"] or DEFAULT_MODEL
    if is_openclaw_agent_target(model):
        return model, None
    return DEFAULT_MODEL if is_openclaw_agent_target(DEFAULT_MODEL) else "openclaw/default", model


def openclaw_get(path: str) -> dict[str, Any]:
    with httpx.Client(timeout=10) as client:
        response = client.get(openclaw_url(path), headers=openclaw_headers())
        response.raise_for_status()
        return response.json()


def check_openclaw() -> bool:
    try:
        openclaw_get("/models")
        return True
    except Exception:
        return False


def extract_text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        text: list[str] = []
        for item in content:
            if isinstance(item, str):
                text.append(item)
            elif isinstance(item, dict):
                item_type = item.get("type")
                if item_type in {"text", "output_text"}:
                    text.append(str(item.get("text") or ""))
        return "".join(text)
    return ""


def parse_chat_completion_text(payload: dict[str, Any]) -> str:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    if not isinstance(message, dict):
        return ""
    return extract_text_from_content(message.get("content"))


def parse_chat_tool_calls(payload: dict[str, Any]) -> list[dict[str, Any]]:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return []
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    if not isinstance(message, dict):
        return []
    calls = message.get("tool_calls")
    if not isinstance(calls, list):
        return []
    result: list[dict[str, Any]] = []
    for call in calls:
        if not isinstance(call, dict):
            continue
        function = call.get("function")
        function = function if isinstance(function, dict) else {}
        arguments = function.get("arguments")
        try:
            parsed_arguments = json.loads(arguments) if isinstance(arguments, str) else arguments
        except json.JSONDecodeError:
            parsed_arguments = {"arguments": arguments}
        result.append(
            {
                "id": call.get("id") or new_id("call"),
                "name": function.get("name") or call.get("name") or "tool",
                "input": parsed_arguments or {},
            }
        )
    return result


def call_openclaw_chat(session_id: str, prompt: str, agent_row: sqlite3.Row) -> dict[str, Any]:
    with config_lock:
        sync_openclaw_mcp_config(agent_row)
        target_model, backend_model = openclaw_request_target(agent_row)
        messages: list[dict[str, str]] = []
        if agent_row["system"]:
            messages.append({"role": "system", "content": agent_row["system"]})
        messages.append({"role": "user", "content": prompt})
        body = {
            "model": target_model,
            "user": session_id,
            "messages": messages,
        }
        with httpx.Client(timeout=OPENCLAW_REQUEST_TIMEOUT_SECONDS) as client:
            response = client.post(
                openclaw_url("/chat/completions"),
                headers=openclaw_headers(session_id=session_id, backend_model=backend_model),
                json=body,
            )
            if response.status_code >= 400:
                raise RuntimeError(
                    f"OpenClaw chat completion failed ({response.status_code}): {clip(response.text, 4_000)}"
                )
            return response.json()


def finish_run(session_id: str) -> None:
    with state_lock:
        active_runs[session_id] = False
        q = run_queues.get(session_id)
    if q:
        q.put({"event": "__done__", "data": {}})


def run_agent(session_id: str, prompt: str) -> None:
    try:
        session = get_session(session_id)
        if not session:
            append_event(session_id, "session.error", {"error": {"message": "session not found"}})
            set_session_status(session_id, "error")
            return
        agent_row = get_agent(session["agent_id"])
        if not agent_row:
            append_event(session_id, "session.error", {"error": {"message": "agent not found"}})
            set_session_status(session_id, "error")
            return

        while True:
            with state_lock:
                abort_flag = abort_flags.setdefault(session_id, threading.Event())
                if abort_flag.is_set():
                    break
            if not set_session_status_if_not_aborted(session_id, "running", abort_flag):
                break
            if not append_event_if_not_aborted(
                session_id,
                "session.status_running",
                {},
                abort_flag,
            ):
                break
            try:
                payload = call_openclaw_chat(session_id, prompt, agent_row)
                if abort_flag.is_set():
                    break
                for tool_call in parse_chat_tool_calls(payload):
                    if not append_event_if_not_aborted(
                        session_id,
                        "agent.tool_use",
                        tool_call,
                        abort_flag,
                    ):
                        break
                if abort_flag.is_set():
                    break
                text = parse_chat_completion_text(payload)
                if not text:
                    text = "OpenClaw completed without emitting message text."
                if not append_event_if_not_aborted(
                    session_id,
                    "agent.message",
                    {
                        "content": [{"type": "text", "text": text}],
                        "model": agent_row["model"] or DEFAULT_MODEL,
                    },
                    abort_flag,
                ):
                    break
                if not append_event_if_not_aborted(
                    session_id,
                    "session.status_idle",
                    {"stop_reason": {"type": "end_turn"}},
                    abort_flag,
                ):
                    break
                if not set_session_status_if_not_aborted(session_id, "idle", abort_flag):
                    break
            except Exception as exc:
                append_event(session_id, "session.error", {"error": {"message": str(exc)}})
                set_session_status(session_id, "error")
                break

            with state_lock:
                pending = pending_prompts.setdefault(session_id, queue.Queue())
                if abort_flag.is_set():
                    drain_queue(pending)
                    break
                try:
                    prompt = pending.get_nowait()
                except queue.Empty:
                    break
    finally:
        finish_run(session_id)


@app.post("/v1/agents")
def create_agent(input: CreateAgentRequest) -> dict[str, Any]:
    validate_mcp_servers_input(input.mcp_servers)
    agent_id = new_id("agt")
    timestamp = now_ms()
    system = input.system_prompt if input.system_prompt is not None else input.system
    with db() as conn:
        conn.execute(
            """
            INSERT INTO agents
              (id, name, description, model, system, tools, mcp_servers, metadata, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                agent_id,
                input.name,
                input.description,
                model_id(input.model),
                system or "",
                json_dumps(input.tools or []),
                json_dumps(input.mcp_servers or []),
                json_dumps(input.metadata) if input.metadata is not None else None,
                timestamp,
                timestamp,
            ),
        )
        row = conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
        sync_openclaw_mcp_config_or_400(row)
    return row_to_agent(row)


@app.get("/v1/agents")
def list_agents() -> dict[str, Any]:
    with db() as conn:
        rows = conn.execute("SELECT * FROM agents ORDER BY created_at ASC").fetchall()
    return {"data": [row_to_agent(row) for row in rows]}


@app.get("/v1/agents/{agent_id}")
def read_agent(agent_id: str) -> dict[str, Any]:
    row = get_agent(agent_id)
    if not row:
        raise HTTPException(status_code=404, detail="agent not found")
    return row_to_agent(row)


@app.patch("/v1/agents/{agent_id}")
def update_agent(agent_id: str, input: CreateAgentRequest) -> dict[str, Any]:
    existing = get_agent(agent_id)
    if not existing:
        raise HTTPException(status_code=404, detail="agent not found")
    validate_mcp_servers_input(input.mcp_servers)
    system = input.system_prompt if input.system_prompt is not None else input.system
    with db() as conn:
        conn.execute(
            """
            UPDATE agents SET
              name = COALESCE(?, name),
              description = COALESCE(?, description),
              model = COALESCE(?, model),
              system = COALESCE(?, system),
              tools = COALESCE(?, tools),
              mcp_servers = COALESCE(?, mcp_servers),
              metadata = COALESCE(?, metadata),
              updated_at = ?
            WHERE id = ?
            """,
            (
                input.name,
                input.description,
                model_id(input.model) if input.model is not None else None,
                system,
                json_dumps(input.tools) if input.tools is not None else None,
                json_dumps(input.mcp_servers) if input.mcp_servers is not None else None,
                json_dumps(input.metadata) if input.metadata is not None else None,
                now_ms(),
                agent_id,
            ),
        )
        row = conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
        sync_openclaw_mcp_config_or_400(row)
    return row_to_agent(row)


@app.post("/v1/environments")
def create_environment(input: CreateEnvironmentRequest) -> dict[str, Any]:
    env_id = new_id("env")
    with db() as conn:
        conn.execute(
            """
            INSERT INTO environments (id, name, config, description, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                env_id,
                input.name,
                json_dumps(input.config or {}),
                input.description,
                now_ms(),
            ),
        )
        row = conn.execute("SELECT * FROM environments WHERE id = ?", (env_id,)).fetchone()
    return row_to_environment(row)


@app.post("/v1/sessions")
def create_session(input: CreateSessionRequest) -> dict[str, Any]:
    if not get_agent(input.agent):
        raise HTTPException(status_code=400, detail="unknown agent")
    session_id = new_id("ses")
    timestamp = now_ms()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO sessions
              (id, agent_id, environment_id, title, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                input.agent,
                input.environment_id,
                input.title or "OpenClaw session",
                "idle",
                timestamp,
                timestamp,
            ),
        )
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    with state_lock:
        abort_flags.setdefault(session_id, threading.Event())
    return row_to_session(row)


@app.post("/v1/sessions/{session_id}/events")
def send_events(session_id: str, input: SendEventsRequest) -> dict[str, Any]:
    if not get_session(session_id):
        raise HTTPException(status_code=404, detail="session not found")
    if has_interrupt(input.events):
        return request_abort(session_id)
    prompt = user_text(input.events)
    if not prompt:
        raise HTTPException(status_code=400, detail="no user.message text")
    message_data = user_message_data(input.events)
    with state_lock:
        abort_flag = abort_flags.setdefault(session_id, threading.Event())
        run_queue = run_queues.setdefault(session_id, queue.Queue())
        pending = pending_prompts.setdefault(session_id, queue.Queue())
        if active_runs.get(session_id) and abort_flag.is_set():
            return JSONResponse(
                status_code=409,
                content={"error": "session abort is still in progress"},
            )
        if active_runs.get(session_id):
            enqueue_event(session_id, store_event(session_id, "user.message", message_data))
            pending.put(prompt)
            return JSONResponse(status_code=202, content={"ok": True, "queued": True})
        abort_flag.clear()
        drain_queue(run_queue)
        drain_queue(pending)
        enqueue_event(session_id, store_event(session_id, "user.message", message_data))
        active_runs[session_id] = True
    thread = threading.Thread(target=run_agent, args=(session_id, prompt), daemon=True)
    thread.start()
    return JSONResponse(status_code=202, content={"ok": True, "queued": False})


@app.get("/v1/sessions/{session_id}/events")
def get_events(session_id: str) -> dict[str, Any]:
    if not get_session(session_id):
        raise HTTPException(status_code=404, detail="session not found")
    return {"data": [{"type": item["event"], **item["data"]} for item in list_events(session_id)]}


@app.post("/v1/sessions/{session_id}/abort")
def abort_session(session_id: str) -> dict[str, Any]:
    if not get_session(session_id):
        raise HTTPException(status_code=404, detail="session not found")
    return request_abort(session_id)


def sse_frame(item: dict[str, Any]) -> str:
    data = {"type": item["event"], **item["data"]}
    return f"event: {item['event']}\ndata: {json_dumps(data)}\n\n"


@app.get("/v1/sessions/{session_id}/events/stream")
def stream_events(session_id: str, x_api_key: str | None = Header(default=None)):
    if not get_session(session_id):
        raise HTTPException(status_code=404, detail="session not found")

    def generate():
        initial_events = list_events(session_id)
        replayed = replay_window_from_events(initial_events)
        seen_ids = {item["id"] for item in initial_events if item.get("id") is not None}
        for item in replayed:
            yield sse_frame(item)
        with state_lock:
            q = run_queues.setdefault(session_id, queue.Queue())
        idle_loops = 0
        while True:
            try:
                item = q.get(timeout=1.0)
            except queue.Empty:
                with state_lock:
                    running = active_runs.get(session_id, False)
                if not running:
                    current = list_events(session_id)
                    unseen = [
                        item
                        for item in current
                        if item.get("id") is not None and item["id"] not in seen_ids
                    ]
                    if unseen:
                        for replay in unseen:
                            seen_ids.add(replay["id"])
                            yield sse_frame(replay)
                    idle_loops += 1
                    if idle_loops >= 2:
                        break
                continue
            if item["event"] == "__done__":
                current = list_events(session_id)
                for replay in current:
                    if replay.get("id") is not None and replay["id"] not in seen_ids:
                        seen_ids.add(replay["id"])
                        yield sse_frame(replay)
                break
            if item.get("id") is None or item["id"] not in seen_ids:
                if item.get("id") is not None:
                    seen_ids.add(item["id"])
                yield sse_frame(item)

    return StreamingResponse(generate(), media_type="text/event-stream")
