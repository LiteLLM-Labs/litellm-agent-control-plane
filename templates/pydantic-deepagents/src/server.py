import asyncio
import json
import os
import queue
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request as UrlRequest
from urllib.request import urlopen

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

try:
    from pydantic_deep import (
        DeepAgentDeps,
        LocalBackend,
        build_mcp_server,
        create_deep_agent,
        parse_mcp_servers,
    )
except Exception:  # pragma: no cover - surfaced by /health
    DeepAgentDeps = None
    LocalBackend = None
    build_mcp_server = None
    create_deep_agent = None
    parse_mcp_servers = None

try:
    from pydantic_ai.models.anthropic import AnthropicModel
    from pydantic_ai.providers.anthropic import AnthropicProvider
except Exception:  # pragma: no cover - surfaced when Anthropic gateway mode is used
    AnthropicModel = None
    AnthropicProvider = None


PORT = int(os.environ.get("PORT", "8080"))
DB_PATH = os.environ.get("DB_PATH", "/data/agents.db")
DEFAULT_MODEL = os.environ.get("DEFAULT_MODEL", "anthropic:claude-sonnet-4-6")
RUNTIME_API_KEY = os.environ.get("RUNTIME_API_KEY")
LITELLM_BASE_URL = os.environ.get("LITELLM_BASE_URL", "").strip().rstrip("/")
LITELLM_API_KEY = os.environ.get("LITELLM_API_KEY", "").strip()
LITELLM_MODELS = os.environ.get("LITELLM_MODELS", "").strip()
LITELLM_API_FORMAT = os.environ.get("LITELLM_API_FORMAT", "openai").strip().lower()
PYDANTIC_DEEP_WORKDIR_ROOT = os.environ.get(
    "PYDANTIC_DEEP_WORKDIR_ROOT",
    "/data/workspaces",
)

if LITELLM_BASE_URL and LITELLM_API_KEY and LITELLM_API_FORMAT != "anthropic":
    openai_base = os.environ.get("LITELLM_OPENAI_BASE_URL", "").strip().rstrip("/")
    if not openai_base:
        openai_base = LITELLM_BASE_URL
        if not openai_base.endswith("/v1"):
            openai_base = f"{openai_base}/v1"
    os.environ.setdefault("OPENAI_BASE_URL", openai_base)
    os.environ.setdefault("OPENAI_API_KEY", LITELLM_API_KEY)


app = FastAPI(title="Pydantic Deep Agents Anthropic Managed Agents bridge")
state_lock = threading.Lock()
run_queues: dict[str, "queue.Queue[dict[str, Any]]"] = {}
active_runs: dict[str, bool] = {}
pending_prompts: dict[str, "queue.Queue[str]"] = {}
aborted_runs: set[str] = set()


def bool_env(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def thinking_env(name: str, default: bool | str) -> bool | str:
    value = os.environ.get(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"0", "false", "no", "off", "none"}:
        return False
    if normalized in {"1", "true", "yes", "on"}:
        return True
    return normalized


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
        "pydantic_deepagents": create_deep_agent is not None and DeepAgentDeps is not None,
        "anthropic_api_key": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "openai_api_key": bool(os.environ.get("OPENAI_API_KEY")),
        "openai_base_url": bool(os.environ.get("OPENAI_BASE_URL")),
        "litellm_base_url": bool(LITELLM_BASE_URL),
        "litellm_api_format": LITELLM_API_FORMAT,
    }


def model_id(model: Any) -> str:
    if isinstance(model, str) and model.strip():
        return model.strip()
    if isinstance(model, dict) and isinstance(model.get("id"), str):
        return model["id"].strip()
    return DEFAULT_MODEL


def provider_alias(provider: str) -> str:
    aliases = {
        "anthropic": "anthropic",
        "claude": "anthropic",
        "openai": "openai",
        "openrouter": "openrouter",
        "google": "google-gla",
        "google-gla": "google-gla",
        "gemini": "google-gla",
        "ollama": "ollama",
    }
    return aliases.get(provider.strip().lower(), provider.strip())


def default_provider() -> str:
    if LITELLM_BASE_URL:
        if LITELLM_API_FORMAT == "anthropic":
            return "anthropic"
        return "openai"
    if ":" in DEFAULT_MODEL:
        return provider_alias(DEFAULT_MODEL.split(":", 1)[0])
    if "/" in DEFAULT_MODEL:
        return provider_alias(DEFAULT_MODEL.split("/", 1)[0])
    return "anthropic"


def normalize_model_for_pydantic_deep(model: str) -> str:
    value = (model or DEFAULT_MODEL).strip()
    if value == "test":
        return value
    if ":" in value:
        return value
    if "/" in value:
        provider, model_name = value.split("/", 1)
        return f"{provider_alias(provider)}:{model_name}"
    return f"{default_provider()}:{value}"


def anthropic_gateway_base_url() -> str:
    return LITELLM_BASE_URL.removesuffix("/v1")


def model_for_pydantic_deep(model: str) -> Any:
    normalized = normalize_model_for_pydantic_deep(model)
    if (
        LITELLM_API_FORMAT == "anthropic"
        and LITELLM_BASE_URL
        and LITELLM_API_KEY
        and normalized.startswith("anthropic:")
    ):
        if AnthropicModel is None or AnthropicProvider is None:
            raise RuntimeError("pydantic_ai Anthropic provider is not importable")
        return AnthropicModel(
            normalized.split(":", 1)[1],
            provider=AnthropicProvider(
                api_key=LITELLM_API_KEY,
                base_url=anthropic_gateway_base_url(),
            ),
        )
    return normalized


def model_info(model: str) -> dict[str, Any]:
    return {
        "id": model,
        "object": "model",
        "created": 0,
        "owned_by": "pydantic-deepagents",
    }


def fallback_models() -> list[str]:
    if LITELLM_MODELS:
        return [item.strip() for item in LITELLM_MODELS.split(",") if item.strip()]
    return [DEFAULT_MODEL]


def model_names_from_payload(payload: dict[str, Any]) -> list[str]:
    data = payload.get("data")
    if isinstance(data, list):
        names = [item.get("id") for item in data if isinstance(item, dict)]
        return [name for name in names if isinstance(name, str) and name]
    models = payload.get("models")
    if isinstance(models, list):
        names = []
        for item in models:
            if isinstance(item, str):
                names.append(item)
            elif isinstance(item, dict):
                value = item.get("id") or item.get("name") or item.get("model_name")
                if isinstance(value, str):
                    names.append(value)
        return names
    return []


def discover_models_from_litellm() -> list[str]:
    if not LITELLM_BASE_URL:
        return []
    headers = {}
    if LITELLM_API_KEY:
        headers["Authorization"] = f"Bearer {LITELLM_API_KEY}"
    urls = [f"{LITELLM_BASE_URL}/models"]
    if not LITELLM_BASE_URL.endswith("/v1"):
        urls.append(f"{LITELLM_BASE_URL}/v1/models")
    for url in urls:
        try:
            request = UrlRequest(url, headers=headers)
            with urlopen(request, timeout=5) as response:
                payload = json.loads(response.read().decode("utf-8"))
            names = model_names_from_payload(payload)
            if names:
                return names
        except (OSError, TimeoutError, URLError, ValueError, json.JSONDecodeError):
            continue
    return []


def json_dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"))


def parse_json(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


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


def insert_event(session_id: str, event: str, data: dict[str, Any]) -> dict[str, Any]:
    if "id" not in data:
        data = {"id": new_id("evt"), **data}
    with db() as conn:
        cursor = conn.execute(
            "INSERT INTO events (session_id, event, data, created_at) VALUES (?, ?, ?, ?)",
            (session_id, event, json_dumps(data), now_ms()),
        )
        event_id = cursor.lastrowid
    return {"id": event_id, "event": event, "data": data}


def append_event_locked(session_id: str, event: str, data: dict[str, Any]) -> dict[str, Any]:
    record = insert_event(session_id, event, data)
    q = run_queues.get(session_id)
    if q:
        q.put(record)
    return record


def append_event(session_id: str, event: str, data: dict[str, Any]) -> dict[str, Any]:
    record = insert_event(session_id, event, data)
    with state_lock:
        q = run_queues.get(session_id)
    if q:
        q.put(record)
    return record


def next_pending_prompt(session_id: str) -> str | None:
    pending = pending_prompts.setdefault(session_id, queue.Queue())
    try:
        return pending.get_nowait()
    except queue.Empty:
        return None


def clear_pending_prompts(session_id: str) -> None:
    pending = pending_prompts.setdefault(session_id, queue.Queue())
    while True:
        try:
            pending.get_nowait()
        except queue.Empty:
            return


def signal_done_locked(session_id: str) -> None:
    q = run_queues.get(session_id)
    if q:
        q.put({"event": "__done__", "data": {}})


def set_session_status(session_id: str, status: str) -> None:
    with db() as conn:
        conn.execute(
            "UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?",
            (status, now_ms(), session_id),
        )


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


def seen_tool_event_ids(session_id: str) -> tuple[set[str], set[str]]:
    seen_tools: set[str] = set()
    seen_results: set[str] = set()
    for item in list_events(session_id):
        data = item["data"]
        if item["event"] == "agent.tool_use" and isinstance(data.get("id"), str):
            seen_tools.add(data["id"])
        if item["event"] == "agent.tool_result" and isinstance(data.get("tool_use_id"), str):
            seen_results.add(data["tool_use_id"])
    return seen_tools, seen_results


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


def clip(value: Any, limit: int = 20_000) -> str:
    text = value if isinstance(value, str) else json_dumps(value)
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... truncated {len(text) - limit} chars"


def part_content_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks: list[str] = []
        for item in content:
            if isinstance(item, str):
                chunks.append(item)
            elif isinstance(item, dict):
                chunks.append(str(item.get("text") or item.get("content") or ""))
            else:
                chunks.append(str(item))
        return "".join(chunks)
    return clip(content)


def result_output_text(result: Any) -> str:
    output = getattr(result, "output", None)
    if output is None and isinstance(result, dict):
        output = result.get("output")
    if output is None:
        return ""
    return part_content_text(output)


def coerce_args(args: Any) -> Any:
    if isinstance(args, str):
        try:
            return json.loads(args)
        except json.JSONDecodeError:
            return {"input": args}
    if args is None:
        return {}
    return args


def part_kind(part: Any) -> str:
    value = getattr(part, "part_kind", "")
    return value if isinstance(value, str) else ""


def emit_text(
    session_id: str,
    text: str,
    model: str,
    seen_text: set[str],
) -> bool:
    body = text.strip()
    if not body or body in seen_text:
        return False
    seen_text.add(body)
    append_event(
        session_id,
        "agent.message",
        {"content": [{"type": "text", "text": body}], "model": model},
    )
    return True


def emit_part_events(
    session_id: str,
    part: Any,
    model: str,
    seen_text: set[str],
    seen_tools: set[str],
    seen_results: set[str],
    pending_tool_ids_by_name: dict[str, list[str]],
    allow_text: bool,
    allow_synthetic_tool_ids: bool,
) -> bool:
    emitted = False
    kind = part_kind(part)
    tool_name = getattr(part, "tool_name", None)
    call_id = getattr(part, "tool_call_id", None) or getattr(part, "id", None)

    if tool_name and (kind == "tool-call" or hasattr(part, "args")):
        tool_key = str(tool_name)
        if not call_id and not allow_synthetic_tool_ids:
            return emitted
        tool_call_id = str(call_id) if call_id else new_id("call")
        if tool_call_id not in seen_tools:
            seen_tools.add(tool_call_id)
            pending_tool_ids_by_name.setdefault(tool_key, []).append(tool_call_id)
            append_event(
                session_id,
                "agent.tool_use",
                {
                    "id": tool_call_id,
                    "name": str(tool_name),
                    "input": coerce_args(getattr(part, "args", {})),
                },
            )
            emitted = True
        return emitted

    if tool_name and (kind == "tool-return" or hasattr(part, "content")):
        tool_key = str(tool_name)
        pending_tool_ids = pending_tool_ids_by_name.setdefault(tool_key, [])
        if call_id:
            tool_call_id = str(call_id)
            if tool_call_id in pending_tool_ids:
                pending_tool_ids.remove(tool_call_id)
        else:
            if not allow_synthetic_tool_ids:
                return emitted
            tool_call_id = pending_tool_ids.pop(0) if pending_tool_ids else new_id("call")
        if tool_call_id not in seen_results:
            seen_results.add(tool_call_id)
            append_event(
                session_id,
                "agent.tool_result",
                {
                    "tool_use_id": tool_call_id,
                    "name": str(tool_name),
                    "content": [
                        {
                            "type": "text",
                            "text": clip(part_content_text(getattr(part, "content", ""))),
                        }
                    ],
                },
            )
            emitted = True
        return emitted

    if allow_text and (kind == "text" or hasattr(part, "content") or hasattr(part, "text")):
        text = part_content_text(
            getattr(part, "content", None) or getattr(part, "text", None),
        )
        emitted = emit_text(session_id, text, model, seen_text) or emitted
    return emitted


def emit_node_events(
    session_id: str,
    node: Any,
    model: str,
    seen_text: set[str],
    seen_tools: set[str],
    seen_results: set[str],
    pending_tool_ids_by_name: dict[str, list[str]],
) -> bool:
    emitted = False
    for attr, allow_text, allow_synthetic_tool_ids in (
        ("model_response", True, True),
        ("request", False, False),
    ):
        message = getattr(node, attr, None)
        parts = getattr(message, "parts", None)
        if not isinstance(parts, list):
            continue
        for part in parts:
            emitted = (
                emit_part_events(
                    session_id,
                    part,
                    model,
                    seen_text,
                    seen_tools,
                    seen_results,
                    pending_tool_ids_by_name,
                    allow_text,
                    allow_synthetic_tool_ids,
                )
                or emitted
            )
    return emitted


def session_workdir(session_id: str) -> Path:
    path = Path(PYDANTIC_DEEP_WORKDIR_ROOT) / session_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def mcp_mapping(raw_servers: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(raw_servers, list):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for index, server in enumerate(raw_servers):
        if not isinstance(server, dict):
            continue
        name = (
            server.get("name")
            or server.get("id")
            or server.get("mcp_server_name")
            or f"mcp_{index + 1}"
        )
        if not isinstance(name, str) or not name:
            continue
        if isinstance(server.get("url"), str):
            headers = dict(server.get("headers") or {})
            token = server.get("authorization_token")
            if isinstance(token, str) and token and "Authorization" not in headers:
                headers["Authorization"] = f"Bearer {token}"
            out[name] = {
                "type": server.get("type") or server.get("transport") or "http",
                "url": server["url"],
                "headers": headers,
            }
        elif isinstance(server.get("command"), str):
            out[name] = {
                "command": server["command"],
                "args": server.get("args") or [],
                "env": server.get("env") or {},
            }
    return out


def build_mcp_toolsets(row: sqlite3.Row) -> list[Any]:
    if parse_mcp_servers is None or build_mcp_server is None:
        return []
    raw = parse_json(row["mcp_servers"], [])
    configs = parse_mcp_servers(mcp_mapping(raw))
    toolsets = []
    for config in configs:
        try:
            toolsets.append(build_mcp_server(config))
        except Exception as exc:
            print(f"[mcp] skipping {getattr(config, 'name', 'server')}: {exc}", flush=True)
    return toolsets


def build_agent(row: sqlite3.Row, backend: Any) -> tuple[Any, list[Any]]:
    if create_deep_agent is None or DeepAgentDeps is None:
        raise RuntimeError("pydantic_deep package is not importable")
    model = model_for_pydantic_deep(row["model"] or DEFAULT_MODEL)
    mcp_toolsets = build_mcp_toolsets(row)
    agent = create_deep_agent(
        model=model,
        instructions=row["system"] or "You are a helpful autonomous assistant.",
        backend=backend,
        mcp_servers=mcp_toolsets or None,
        include_todo=bool_env("PYDANTIC_DEEP_TODO", True),
        include_filesystem=bool_env("PYDANTIC_DEEP_FILESYSTEM", True),
        include_subagents=bool_env("PYDANTIC_DEEP_SUBAGENTS", True),
        include_skills=bool_env("PYDANTIC_DEEP_SKILLS", True),
        include_builtin_subagents=bool_env("PYDANTIC_DEEP_BUILTIN_SUBAGENTS", True),
        include_plan=bool_env("PYDANTIC_DEEP_PLAN", True),
        include_memory=bool_env("PYDANTIC_DEEP_MEMORY", True),
        include_execute=bool_env("PYDANTIC_DEEP_EXECUTE", True),
        include_checkpoints=bool_env("PYDANTIC_DEEP_CHECKPOINTS", False),
        include_teams=bool_env("PYDANTIC_DEEP_TEAMS", False),
        include_liteparse=bool_env("PYDANTIC_DEEP_LITEPARSE", False),
        web_search=bool_env("PYDANTIC_DEEP_WEB_SEARCH", True),
        web_fetch=bool_env("PYDANTIC_DEEP_WEB_FETCH", True),
        thinking=thinking_env(
            "PYDANTIC_DEEP_THINKING",
            False if LITELLM_API_FORMAT == "anthropic" else "high",
        ),
        context_manager=bool_env("PYDANTIC_DEEP_CONTEXT_MANAGER", True),
        cost_tracking=bool_env("PYDANTIC_DEEP_COST_TRACKING", True),
        forking=bool_env("PYDANTIC_DEEP_FORKING", False),
        history_messages_path=f".pydantic-deep/{row['id']}/messages.json",
    )
    return agent, mcp_toolsets


async def run_agent_once(
    session_id: str,
    prompt: str,
    agent_row: sqlite3.Row,
) -> None:
    if LocalBackend is None or DeepAgentDeps is None:
        raise RuntimeError("pydantic_deep backend dependencies are not importable")
    backend = LocalBackend(root_dir=str(session_workdir(session_id)))
    deps = DeepAgentDeps(backend=backend)
    agent, mcp_toolsets = build_agent(agent_row, backend)
    model = normalize_model_for_pydantic_deep(agent_row["model"] or DEFAULT_MODEL)
    seen_text: set[str] = set()
    seen_tools, seen_results = seen_tool_event_ids(session_id)
    pending_tool_ids_by_name: dict[str, list[str]] = {}

    async def execute() -> None:
        async with agent.iter(prompt, deps=deps) as run:
            async for node in run:
                emit_node_events(
                    session_id,
                    node,
                    model,
                    seen_text,
                    seen_tools,
                    seen_results,
                    pending_tool_ids_by_name,
                )
            emit_text(session_id, result_output_text(run.result), model, seen_text)

    if mcp_toolsets:
        async with agent:
            await execute()
    else:
        await execute()


def run_agent(session_id: str, prompt: str) -> None:
    session = get_session(session_id)
    if not session:
        append_event(session_id, "session.error", {"error": {"message": "session not found"}})
        with state_lock:
            active_runs[session_id] = False
            aborted_runs.discard(session_id)
            signal_done_locked(session_id)
        return
    agent_row = get_agent(session["agent_id"])
    if not agent_row:
        append_event(session_id, "session.error", {"error": {"message": "agent not found"}})
        set_session_status(session_id, "error")
        with state_lock:
            active_runs[session_id] = False
            aborted_runs.discard(session_id)
            signal_done_locked(session_id)
        return

    while True:
        with state_lock:
            if session_id in aborted_runs:
                clear_pending_prompts(session_id)
                set_session_status(session_id, "error")
                active_runs[session_id] = False
                aborted_runs.discard(session_id)
                signal_done_locked(session_id)
                return
        set_session_status(session_id, "running")
        append_event(session_id, "session.status_running", {})
        success = True
        try:
            asyncio.run(run_agent_once(session_id, prompt, agent_row))
        except Exception as exc:
            success = False
            append_event(session_id, "session.error", {"error": {"message": str(exc)}})
            set_session_status(session_id, "error")

        with state_lock:
            if session_id in aborted_runs:
                clear_pending_prompts(session_id)
                set_session_status(session_id, "error")
                active_runs[session_id] = False
                aborted_runs.discard(session_id)
                signal_done_locked(session_id)
                return
            if not success:
                clear_pending_prompts(session_id)
                active_runs[session_id] = False
                signal_done_locked(session_id)
                return
            append_event_locked(
                session_id,
                "session.status_idle",
                {"stop_reason": {"type": "end_turn"}},
            )
            set_session_status(session_id, "idle")
            queued_prompt = next_pending_prompt(session_id)
            if queued_prompt is not None:
                prompt = queued_prompt
                continue
            active_runs[session_id] = False
            signal_done_locked(session_id)
            return


@app.get("/v1/models")
def list_models() -> dict[str, Any]:
    models = discover_models_from_litellm() or fallback_models()
    return {"object": "list", "data": [model_info(model) for model in models]}


@app.post("/v1/agents")
def create_agent(input: CreateAgentRequest) -> dict[str, Any]:
    agent_id = new_id("agt")
    timestamp = now_ms()
    system = input.system_prompt if input.system_prompt is not None else input.system
    with db() as conn:
        conn.execute(
            """
            INSERT INTO agents
              (
                id, name, description, model, system, tools, mcp_servers,
                metadata, created_at, updated_at
              )
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
                input.title or "Pydantic Deep Agents session",
                "idle",
                timestamp,
                timestamp,
            ),
        )
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return row_to_session(row)


@app.post("/v1/sessions/{session_id}/events")
def send_events(session_id: str, input: SendEventsRequest) -> JSONResponse:
    if not get_session(session_id):
        raise HTTPException(status_code=404, detail="session not found")
    prompt = user_text(input.events)
    if not prompt:
        raise HTTPException(status_code=400, detail="no user.message text")
    with state_lock:
        run_queues.setdefault(session_id, queue.Queue())
        pending_prompts.setdefault(session_id, queue.Queue())
        if active_runs.get(session_id):
            if session_id in aborted_runs:
                return JSONResponse(
                    status_code=409,
                    content={"ok": False, "queued": False, "error": "session abort in progress"},
                )
            pending_prompts[session_id].put(prompt)
            return JSONResponse(status_code=202, content={"ok": True, "queued": True})
        aborted_runs.discard(session_id)
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
    with state_lock:
        aborted_runs.add(session_id)
        clear_pending_prompts(session_id)
        append_event_locked(
            session_id,
            "session.error",
            {"error": {"message": "interrupt is not supported by this template"}},
        )
        set_session_status(session_id, "error")
        if not active_runs.get(session_id):
            active_runs[session_id] = False
            aborted_runs.discard(session_id)
        signal_done_locked(session_id)
    return {"aborted": False}


def sse_frame(item: dict[str, Any]) -> str:
    data = {**item["data"], "type": item["event"]}
    return f"event: {item['event']}\ndata: {json_dumps(data)}\n\n"


@app.get("/v1/sessions/{session_id}/events/stream")
def stream_events(session_id: str, x_api_key: str | None = Header(default=None)):
    if not get_session(session_id):
        raise HTTPException(status_code=404, detail="session not found")

    def generate():
        replayed = list_events(session_id)
        seen_ids = {item["id"] for item in replayed if item.get("id") is not None}
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
