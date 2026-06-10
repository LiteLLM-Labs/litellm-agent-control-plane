import json
import os
import queue
import re
import shutil
import sqlite3
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel


PORT = int(os.environ.get("PORT", "8080"))
DB_PATH = os.environ.get("DB_PATH", "/data/agents.db")
DEFAULT_MODEL = os.environ.get("DEFAULT_MODEL", "anthropic/claude-sonnet-4-5")
RUNTIME_API_KEY = os.environ.get("RUNTIME_API_KEY")
LAP_BASE_URL = os.environ.get("LAP_BASE_URL", "").strip().rstrip("/")
LAP_API_KEY = os.environ.get("LAP_API_KEY", "").strip()
HERMES_COMMAND = os.environ.get("HERMES_COMMAND", "hermes")
HERMES_HOME_ROOT = os.environ.get("HERMES_HOME_ROOT", "/data/hermes-home")
HERMES_WORKDIR = os.environ.get("HERMES_WORKDIR", "/tmp/hermes-workspace")
HERMES_TOOLSETS = os.environ.get("HERMES_TOOLSETS", "terminal,web")
HERMES_MAX_TURNS = int(os.environ.get("HERMES_MAX_TURNS", "20"))
HERMES_TIMEOUT_SECONDS = int(os.environ.get("HERMES_TIMEOUT_SECONDS", "300"))


app = FastAPI(title="Hermes Agent Anthropic Managed Agents bridge")
state_lock = threading.Lock()
run_queues: dict[str, "queue.Queue[dict[str, Any]]"] = {}
active_runs: dict[str, bool] = {}
pending_prompts: dict[str, "queue.Queue[str]"] = {}


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
    hermes_path = shutil.which(HERMES_COMMAND)
    return {
        "ok": True,
        "hermes": hermes_path is not None,
        "hermes_command": hermes_path or HERMES_COMMAND,
        "lap_base_url": bool(LAP_BASE_URL),
        "lap_api_key": bool(LAP_API_KEY),
    }


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


def append_event(session_id: str, event: str, data: dict[str, Any]) -> dict[str, Any]:
    if "id" not in data:
        data = {"id": new_id("sevt"), **data}
    with db() as conn:
        cursor = conn.execute(
            "INSERT INTO events (session_id, event, data, created_at) VALUES (?, ?, ?, ?)",
            (session_id, event, json_dumps(data), now_ms()),
        )
        event_id = cursor.lastrowid
    record = {"id": event_id, "event": event, "data": data}
    with state_lock:
        q = run_queues.get(session_id)
    if q:
        q.put(record)
    return record


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


def message_text(message: Any) -> str:
    content = getattr(message, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        text: list[str] = []
        for item in content:
            if isinstance(item, str):
                text.append(item)
            elif isinstance(item, dict):
                text.append(str(item.get("text") or item.get("content") or ""))
        return "".join(text)
    return ""


def parse_tool_arguments(value: Any) -> Any:
    if not isinstance(value, str):
        return value if value is not None else {}
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return {"arguments": value}


def parse_tool_output(value: str | None) -> tuple[Any, Any]:
    if not value:
        return "", None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return value, None
    if not isinstance(parsed, dict):
        return parsed, None
    output = parsed.get("output", parsed)
    error = parsed.get("error")
    exit_code = parsed.get("exit_code")
    if error is None and isinstance(exit_code, int) and exit_code != 0:
        error = {"exit_code": exit_code, "output": output}
    return output, error


def emit_hermes_state_events(session_id: str, model: str, started_at: float) -> bool:
    state_path = hermes_home(session_id) / "state.db"
    if not state_path.exists():
        return False
    emitted = False
    with sqlite3.connect(state_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT role, content, tool_call_id, tool_calls, tool_name, timestamp, finish_reason
            FROM messages
            WHERE timestamp >= ?
            ORDER BY timestamp ASC, id ASC
            """,
            (started_at - 0.001,),
        ).fetchall()
    for row in rows:
        role = row["role"]
        content = row["content"] or ""
        if role == "assistant":
            if content.strip():
                append_event(
                    session_id,
                    "agent.message",
                    {"content": [{"type": "text", "text": content}], "model": model},
                )
                emitted = True
            tool_calls = parse_json(row["tool_calls"], [])
            if isinstance(tool_calls, list):
                for call in tool_calls:
                    if not isinstance(call, dict):
                        continue
                    function = call.get("function")
                    function = function if isinstance(function, dict) else {}
                    call_id = call.get("id") or call.get("call_id") or f"call_{uuid.uuid4().hex}"
                    append_event(
                        session_id,
                        "agent.tool_use",
                        {
                            "id": call_id,
                            "name": function.get("name") or call.get("name") or "tool",
                            "input": parse_tool_arguments(function.get("arguments") or call.get("arguments")),
                        },
                    )
                    emitted = True
        elif role == "tool":
            tool_call_id = row["tool_call_id"] or f"call_{uuid.uuid4().hex}"
            output, error = parse_tool_output(content)
            data = {
                "tool_use_id": tool_call_id,
                "name": row["tool_name"] or "tool",
                "content": [{"type": "text", "text": clip(output, 8_000)}],
                "output": output,
            }
            if error is not None:
                data["error"] = error
            append_event(session_id, "agent.tool_result", data)
            emitted = True
    return emitted


def messages_from_update(update: Any) -> list[Any]:
    if not isinstance(update, dict):
        return []
    messages: list[Any] = []
    for value in update.values():
        if not isinstance(value, dict):
            continue
        raw = value.get("messages")
        if raw is None:
            continue
        raw = getattr(raw, "value", raw)
        if isinstance(raw, list):
            messages.extend(raw)
    return messages


def message_key(message: Any, fallback: str) -> str:
    message_id = getattr(message, "id", None)
    if isinstance(message_id, str) and message_id:
        return message_id
    return fallback


def emit_message_events(
    session_id: str,
    message: Any,
    model: str,
    seen_text: set[str],
    seen_tools: set[str],
    seen_results: set[str],
) -> bool:
    emitted = False
    for call in getattr(message, "tool_calls", None) or []:
        call_id = call.get("id") or f"call_{uuid.uuid4().hex}"
        if call_id in seen_tools:
            continue
        seen_tools.add(call_id)
        append_event(
            session_id,
            "agent.tool_use",
            {
                "id": call_id,
                "name": call.get("name"),
                "input": call.get("args") or {},
            },
        )
        emitted = True

    tool_call_id = getattr(message, "tool_call_id", None)
    if isinstance(tool_call_id, str) and tool_call_id and tool_call_id not in seen_results:
        seen_results.add(tool_call_id)
        append_event(
            session_id,
            "agent.tool_result",
            {
                "tool_use_id": tool_call_id,
                "name": getattr(message, "name", None),
                "content": [{"type": "text", "text": clip(message_text(message))}],
            },
        )
        return True

    text = message_text(message)
    key = message_key(message, f"text_{len(seen_text)}_{hash(text)}")
    if text and key not in seen_text and not getattr(message, "tool_calls", None):
        seen_text.add(key)
        append_event(
            session_id,
            "agent.message",
            {"content": [{"type": "text", "text": text}], "model": model},
        )
        emitted = True
    return emitted


def clip(text: Any, limit: int = 20_000) -> str:
    value = text if isinstance(text, str) else json_dumps(text)
    if len(value) <= limit:
        return value
    return value[:limit] + f"\n... truncated {len(value) - limit} chars"


def redact_error_detail(text: str) -> str:
    redacted = text
    for secret in (LAP_API_KEY, RUNTIME_API_KEY, os.environ.get("ANTHROPIC_API_KEY", "")):
        if secret:
            redacted = redacted.replace(secret, "[redacted]")
    return re.sub(r"sk-ant-api[0-9A-Za-z_-]+", "sk-ant-api[redacted]", redacted)


def hermes_home(session_id: str) -> Path:
    path = Path(HERMES_HOME_ROOT) / session_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_hermes_context(session_id: str, agent_row: sqlite3.Row) -> None:
    if not LAP_BASE_URL:
        raise RuntimeError("LAP_BASE_URL is required")
    if not LAP_API_KEY:
        raise RuntimeError("LAP_API_KEY is required")
    home = hermes_home(session_id)
    workdir = Path(HERMES_WORKDIR) / session_id
    workdir.mkdir(parents=True, exist_ok=True)
    system = (agent_row["system"] or "You are a helpful assistant.").strip()
    agent_name = agent_row["name"] or "Hermes Agent"
    context = f"# {agent_name}\n\n{system}\n"
    (workdir / "AGENTS.md").write_text(context, encoding="utf-8")
    config = {
        "model": {
            "provider": "custom:lap",
            "default": agent_row["model"] or DEFAULT_MODEL,
            "base_url": LAP_BASE_URL,
            "api_mode": "anthropic_messages",
        },
        "providers": {
            "lap": {
                "name": "LiteLLM Agent Platform",
                "api": LAP_BASE_URL,
                "key_env": "LAP_API_KEY",
                "default_model": agent_row["model"] or DEFAULT_MODEL,
                "transport": "anthropic_messages",
            }
        },
        "display": {"interface": "cli"},
    }
    (home / "config.yaml").write_text(json.dumps(config), encoding="utf-8")


def hermes_env(session_id: str) -> dict[str, str]:
    env = os.environ.copy()
    env["HERMES_HOME"] = str(hermes_home(session_id))
    env["HERMES_QUIET"] = "1"
    env["HERMES_NO_UPDATE_CHECK"] = "1"
    env["LAP_API_KEY"] = LAP_API_KEY
    env["NO_COLOR"] = "1"
    return env


def clean_hermes_output(output: str) -> str:
    lines = []
    skip_next_normalized_provider_line = False
    for line in output.splitlines():
        stripped = line.strip()
        if skip_next_normalized_provider_line:
            skip_next_normalized_provider_line = False
            if stripped.endswith(".") and " " not in stripped.rstrip("."):
                continue
        if "Normalized model" in stripped:
            skip_next_normalized_provider_line = True
            continue
        if "security scanner enabled but not available" in stripped:
            continue
        if stripped.startswith("session_id:"):
            continue
        lines.append(line)
    return "\n".join(lines).strip()


def hermes_error_log_detail(session_id: str) -> str:
    log_path = hermes_home(session_id) / "logs" / "errors.log"
    try:
        raw = log_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""
    except OSError:
        return ""
    return "\n".join(raw.splitlines()[-40:]).strip()


def hermes_failure_detail(session_id: str, proc: subprocess.CompletedProcess[str], output: str) -> str:
    parts = [
        clean_hermes_output(proc.stderr or ""),
        output,
        hermes_error_log_detail(session_id),
    ]
    detail = "\n".join(part for part in parts if part).strip()
    if not detail:
        detail = f"Hermes exited with {proc.returncode}"
    return clip(redact_error_detail(detail), 4_000)


def run_hermes_cli(session_id: str, prompt: str, agent_row: sqlite3.Row) -> tuple[str, bool]:
    write_hermes_context(session_id, agent_row)
    workdir = Path(HERMES_WORKDIR) / session_id
    started_at = time.time()
    command = [
        HERMES_COMMAND,
        "chat",
        "--quiet",
        "--provider",
        "custom:lap",
        "--model",
        agent_row["model"] or DEFAULT_MODEL,
        "--toolsets",
        HERMES_TOOLSETS,
        "--max-turns",
        str(HERMES_MAX_TURNS),
        "-q",
        prompt,
    ]
    proc = subprocess.run(
        command,
        cwd=workdir,
        env=hermes_env(session_id),
        text=True,
        capture_output=True,
        timeout=HERMES_TIMEOUT_SECONDS,
    )
    output = clean_hermes_output(proc.stdout or "")
    if proc.returncode != 0:
        raise RuntimeError(hermes_failure_detail(session_id, proc, output))
    if not output:
        raise RuntimeError("Hermes completed without emitting message text")
    emitted = emit_hermes_state_events(session_id, agent_row["model"] or DEFAULT_MODEL, started_at)
    return output, emitted


def run_agent(session_id: str, prompt: str) -> None:
    session = get_session(session_id)
    if not session:
        append_event(session_id, "session.error", {"error": {"message": "session not found"}})
        return
    agent_row = get_agent(session["agent_id"])
    if not agent_row:
        append_event(session_id, "session.error", {"error": {"message": "agent not found"}})
        return
    while True:
        set_session_status(session_id, "running")
        append_event(session_id, "session.status_running", {})
        emitted = False
        seen_text: set[str] = set()
        seen_tools: set[str] = set()
        seen_results: set[str] = set()
        try:
            response, emitted = run_hermes_cli(session_id, prompt, agent_row)
            if not emitted:
                append_event(
                    session_id,
                    "agent.message",
                    {"content": [{"type": "text", "text": response}], "model": agent_row["model"]},
                )
                emitted = True
            append_event(
                session_id,
                "session.status_idle",
                {"stop_reason": {"type": "end_turn"}},
            )
            set_session_status(session_id, "idle")
        except Exception as exc:
            append_event(session_id, "session.error", {"error": {"message": str(exc)}})
            set_session_status(session_id, "error")
            break

        with state_lock:
            pending = pending_prompts.setdefault(session_id, queue.Queue())
            try:
                prompt = pending.get_nowait()
            except queue.Empty:
                break

    with state_lock:
        active_runs[session_id] = False
        q = run_queues.get(session_id)
    if q:
        q.put({"event": "__done__", "data": {}})


@app.post("/v1/agents")
def create_agent(input: CreateAgentRequest) -> dict[str, Any]:
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
                input.title or "Hermes Agent session",
                "idle",
                timestamp,
                timestamp,
            ),
        )
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return row_to_session(row)


@app.post("/v1/sessions/{session_id}/events")
def send_events(session_id: str, input: SendEventsRequest) -> dict[str, Any]:
    if not get_session(session_id):
        raise HTTPException(status_code=404, detail="session not found")
    prompt = user_text(input.events)
    if not prompt:
        raise HTTPException(status_code=400, detail="no user.message text")
    append_event(session_id, "user.message", user_message_data(input.events))
    with state_lock:
        run_queues.setdefault(session_id, queue.Queue())
        pending_prompts.setdefault(session_id, queue.Queue())
        if active_runs.get(session_id):
            pending_prompts[session_id].put(prompt)
            return JSONResponse(status_code=202, content={"ok": True, "queued": True})
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
    append_event(
        session_id,
        "session.error",
        {"error": {"message": "interrupt is not supported by this Hermes Agent template"}},
    )
    set_session_status(session_id, "error")
    with state_lock:
        active_runs[session_id] = False
        q = run_queues.get(session_id)
    if q:
        q.put({"event": "__done__", "data": {}})
    return {"aborted": False}


def sse_frame(item: dict[str, Any]) -> str:
    data = {"type": item["event"], **item["data"]}
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
