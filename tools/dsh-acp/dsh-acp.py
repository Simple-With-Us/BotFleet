#!/usr/bin/env python3
"""ACP stdio bridge for the DeepSeek Harness (`dsh`).

Fleet-authored, Python standard library only — no third-party imports, so it
runs under any system `python3` without an install step.  Originally written
for the Shellular spawn path; vendored into BotFleet so the `dshAgent` driver
has a real ACP server to spawn.  The `dsh` CLI has no `acp` subcommand of its
own, so without this bridge the engine spawns nothing.

Stdout is JSON-RPC only.  Drives `dsh --profile headless`.  Auth comes from
the process env or `$DSH_HOME/.credentials.yaml` — never from agents.json.

Headless dsh prints nothing until the final answer, so this bridge must
(1) detach the child from ACP stdin, (2) stream heartbeats so the client
leaves Thinking, and (3) kill the process group on timeout or cancel.

Environment:
  DSH_BIN             Path to the dsh executable.  When unset the bridge
                      looks for `dsh` on PATH, then
                      $DSH_RUNTIME_ROOT/node_modules/.bin/dsh.
  DSH_RUNTIME_ROOT    Optional root of a local dsh install.  No default —
                      this file ships inside a product, so it must not
                      assume any one machine's layout.
  DSH_HOME            Harness home directory.  Defaults to ~/.dsh.
  DSH_PERMISSION_MODE Approval posture handed to dsh.  Deliberately NOT
                      defaulted here: an unset value inherits the harness's
                      own interactive default rather than silently granting
                      full filesystem and shell access.  The host (BotFleet)
                      passes the mode that matches the bot's approval
                      setting.  See docs/dsh-engine.md.
  DSH_ACP_TIMEOUT_SEC     Per-turn wall clock, default 900.
  DSH_ACP_HEARTBEAT_SEC   Thought-chunk heartbeat, default 5.

Sibling copies: ai-fleet-coordinator/scripts/dsh-acp.py (Shellular) and
~/apps/dsh-runtime/dsh-acp.py (live install on the fleet Mac).  Those keep
the Mac-specific auto-approve posture; this one does not.
"""

from __future__ import annotations

import datetime
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

def resolve_dsh_bin() -> str:
    """Locate the dsh executable.  Explicit env wins, then PATH, then a local
    runtime root.  Returns the bare name `dsh` when nothing resolves so the
    spawn failure names the missing binary instead of a stale absolute path."""
    explicit = os.environ.get("DSH_BIN")
    if explicit:
        return explicit
    on_path = shutil.which("dsh")
    if on_path:
        return on_path
    root = os.environ.get("DSH_RUNTIME_ROOT")
    if root:
        candidate = Path(root) / "node_modules" / ".bin" / "dsh"
        if candidate.exists():
            return str(candidate)
    return "dsh"


DSH_BIN = resolve_dsh_bin()
DSH_HOME = os.environ.get("DSH_HOME", os.path.expanduser("~/.dsh"))
DEFAULT_TIMEOUT_SEC = int(os.environ.get("DSH_ACP_TIMEOUT_SEC", "900"))
DEFAULT_HEARTBEAT_SEC = float(os.environ.get("DSH_ACP_HEARTBEAT_SEC", "5"))
# No default.  None means "do not inject" — dsh keeps its own posture, which
# asks before acting.  Only the host may widen that.
DEFAULT_PERMISSION_MODE = os.environ.get("DSH_PERMISSION_MODE") or None

JsonDict = dict[str, Any]


def _load_key_from_dsh_credentials() -> None:
    if os.environ.get("DEEPSEEK_API_KEY"):
        return
    cred = Path(DSH_HOME) / ".credentials.yaml"
    if not cred.is_file():
        return
    try:
        text = cred.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key_name = ""
        val = ""
        if ":" in line:
            key_name, val = line.split(":", 1)
        elif "=" in line:
            key_name, val = line.split("=", 1)
        else:
            continue
        name = key_name.strip().lower().replace("-", "_")
        if name in {"api_key", "apikey", "deepseek_api_key", "token"}:
            val = val.strip().strip("'").strip('"')
            if val:
                os.environ["DEEPSEEK_API_KEY"] = val
                return


_load_key_from_dsh_credentials()

out_lock = threading.Lock()
sessions: dict[str, JsonDict] = {}
active_procs: dict[str, subprocess.Popen[str]] = {}
active_lock = threading.Lock()


def write(payload: JsonDict) -> None:
    raw = json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n"
    with out_lock:
        sys.stdout.write(raw)
        sys.stdout.flush()


def reply(req_id: Any, result: JsonDict) -> None:
    write({"jsonrpc": "2.0", "id": req_id, "result": result})


def fail(req_id: Any, message: str, code: int = -32000) -> None:
    write(
        {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": code, "message": message},
        }
    )


def notify(method: str, params: JsonDict) -> None:
    write({"jsonrpc": "2.0", "method": method, "params": params})


def emit_text(session_id: str, text: str) -> None:
    if not text:
        return
    notify(
        "session/update",
        {
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": text},
            },
        },
    )


def emit_thought(session_id: str, text: str) -> None:
    if not text:
        return
    notify(
        "session/update",
        {
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "agent_thought_chunk",
                "content": {"type": "text", "text": text},
            },
        },
    )


def extract_prompt_text(prompt: Any) -> str:
    parts: list[str] = []
    if isinstance(prompt, str):
        return prompt.strip()
    if not isinstance(prompt, list):
        return ""
    for item in prompt:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, dict):
            text = item.get("text")
            if text is None and isinstance(item.get("content"), str):
                text = item.get("content")
            if text:
                parts.append(str(text))
    return "\n".join(parts).strip()


def modes_block() -> JsonDict:
    return {
        "currentModeId": "agent",
        "availableModes": [
            {"id": "agent", "name": "Agent"},
        ],
    }


def _drain_stderr(proc: subprocess.Popen[str], session_id: str) -> None:
    stderr = proc.stderr
    if stderr is None:
        return
    try:
        for line in stderr:
            stripped = line.strip()
            if stripped:
                emit_text(session_id, f"[stderr] {stripped}\n")
    except (OSError, ValueError):
        pass


def _clear_active(session_id: str, proc: subprocess.Popen[str]) -> None:
    with active_lock:
        current = active_procs.get(session_id)
        if current is proc:
            active_procs.pop(session_id, None)


def _close_pipe(stream: Any) -> None:
    if stream is None:
        return
    try:
        stream.close()
    except (OSError, ValueError):
        pass


def _kill_proc_group(proc: subprocess.Popen[str]) -> None:
    pid = proc.pid
    if pid:
        try:
            os.killpg(pid, signal.SIGTERM)
        except (OSError, ProcessLookupError):
            try:
                proc.terminate()
            except OSError:
                pass
        try:
            proc.wait(timeout=3)
        except (subprocess.TimeoutExpired, OSError):
            try:
                os.killpg(pid, signal.SIGKILL)
            except (OSError, ProcessLookupError):
                try:
                    proc.kill()
                except OSError:
                    pass
    _close_pipe(proc.stdout)
    _close_pipe(proc.stderr)


def cancel_session(session_id: str) -> bool:
    with active_lock:
        proc = active_procs.get(session_id)
    if proc is None:
        return False
    _kill_proc_group(proc)
    return True


def build_dsh_cmd(session_id: str, prompt_text: str) -> list[str]:
    """Argv for one headless turn.

    Deliberately no --resume.  The headless profile's own parser accepts a
    task positional and -h, nothing else, and it does NOT allow unknown
    options — so a stray --resume is a parse error that exits non-zero before
    the model is ever reached.  Every turn is therefore a fresh agent; the
    session id below only groups OUR bookkeeping, it does not resume dsh's.
    Real resume needs a profile that threads a caller-supplied id into
    dsh-session's store; see docs/dsh-engine.md.
    """
    del session_id
    return [DSH_BIN, "--profile", "headless", prompt_text]


def handle_prompt(req_id: Any, session_id: str, prompt_text: str, cwd: str) -> None:
    env = os.environ.copy()
    env["DSH_HOME"] = DSH_HOME
    if DEFAULT_PERMISSION_MODE:
        env.setdefault("DSH_PERMISSION_MODE", DEFAULT_PERMISSION_MODE)
    env["DSH_SESSION_ID"] = session_id
    env["DSH_RESUME"] = session_id
    cmd = build_dsh_cmd(session_id, prompt_text)
    workdir = cwd if os.path.isdir(cwd) else None
    proc: subprocess.Popen[str] | None = None
    timed_out = False
    replied = False
    stdout_done = threading.Event()
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=workdir,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            start_new_session=True,
        )
        with active_lock:
            active_procs[session_id] = proc

        def read_stdout() -> None:
            try:
                stdout = proc.stdout
                if stdout is None:
                    return
                for line in stdout:
                    emit_text(session_id, line)
            except (OSError, ValueError):
                pass
            finally:
                stdout_done.set()

        stdout_thread = threading.Thread(target=read_stdout, daemon=True)
        stdout_thread.start()
        stderr_thread = threading.Thread(
            target=_drain_stderr,
            args=(proc, session_id),
            daemon=True,
        )
        stderr_thread.start()

        started = time.monotonic()
        heartbeat = max(DEFAULT_HEARTBEAT_SEC, 0.5)
        while not stdout_done.wait(timeout=heartbeat):
            elapsed = int(time.monotonic() - started)
            if elapsed >= DEFAULT_TIMEOUT_SEC:
                timed_out = True
                emit_text(
                    session_id,
                    f"\n[dsh-acp] Timed out after {DEFAULT_TIMEOUT_SEC}s.\n",
                )
                _kill_proc_group(proc)
                break
            marker = f"[working… {elapsed}s]\n"
            emit_thought(session_id, marker)

        stdout_thread.join(timeout=2)
        stderr_thread.join(timeout=2)
        if proc.poll() is None:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                _kill_proc_group(proc)
        if timed_out:
            pass
        elif proc.returncode not in (0, None, -9, -15):
            emit_text(
                session_id,
                f"dsh exited with code {proc.returncode}\n",
            )
        reply(req_id, {"stopReason": "endTurn"})
        replied = True
    except Exception as exc:
        emit_text(session_id, f"Execution error: {exc}\n")
        if not replied:
            reply(req_id, {"stopReason": "endTurn"})
            replied = True
    finally:
        if proc is not None:
            _clear_active(session_id, proc)
        if not replied:
            reply(req_id, {"stopReason": "endTurn"})


def list_dsh_sessions() -> list[JsonDict]:
    sess_root = Path(DSH_HOME) / "sessions"
    if not sess_root.is_dir():
        return []
    items: list[JsonDict] = []
    try:
        for dir_entry in sess_root.iterdir():
            if not dir_entry.is_dir() or dir_entry.name == "acp":
                continue
            raw_path = dir_entry.name.strip("-").replace("-", "/")
            cwd = "/" + raw_path if raw_path else str(Path.home())
            for sess_dir in dir_entry.iterdir():
                if not sess_dir.is_dir():
                    continue
                sess_id = sess_dir.name
                try:
                    mtime = sess_dir.stat().st_mtime
                    dt = datetime.datetime.fromtimestamp(
                        mtime,
                        tz=datetime.timezone.utc,
                    ).isoformat()
                except OSError:
                    dt = None
                repo_name = Path(cwd).name if Path(cwd).name else "DeepSeek"
                display_title = f"{repo_name}: {sess_id.replace('session-', '')[:8]}"
                items.append(
                    {
                        "sessionId": sess_id,
                        "cwd": cwd,
                        "title": display_title,
                        "updatedAt": dt,
                    }
                )
    except Exception:
        pass
    items.sort(key=lambda x: x.get("updatedAt") or "", reverse=True)
    return items[:50]


def main() -> None:
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = req.get("method")
        req_id = req.get("id")
        params = req.get("params") if isinstance(req.get("params"), dict) else {}

        if method == "initialize":
            version = params.get("protocolVersion", 1)
            reply(
                req_id,
                {
                    "protocolVersion": version,
                    "agentCapabilities": {
                        "loadSession": True,
                        "promptCapabilities": {
                            "image": False,
                            "audio": False,
                            "embeddedContext": True,
                        },
                        "sessionCapabilities": {
                            "list": {},
                        },
                    },
                    "agentInfo": {
                        "name": "deepseek-harness-acp",
                        "version": "1.3.0",
                    },
                    "authMethods": [],
                },
            )
        elif method == "authenticate":
            reply(req_id, {})
        elif method == "session/list":
            reply(req_id, {"sessions": list_dsh_sessions()})
        elif method == "session/new":
            sess_id = str(uuid.uuid4())
            cwd = params.get("cwd") if isinstance(params.get("cwd"), str) else os.getcwd()
            sessions[sess_id] = {"cwd": cwd, "sessionId": sess_id}
            reply(req_id, {"sessionId": sess_id, "modes": modes_block()})
        elif method == "session/load":
            sess_id = str(params.get("sessionId") or uuid.uuid4())
            cwd = params.get("cwd") if isinstance(params.get("cwd"), str) else os.getcwd()
            sessions[sess_id] = {"cwd": cwd, "sessionId": sess_id}
            reply(req_id, {"sessionId": sess_id, "modes": modes_block()})
        elif method == "session/prompt":
            sess_id = str(params.get("sessionId") or "")
            text = extract_prompt_text(params.get("prompt"))
            if not text:
                fail(req_id, "empty prompt")
                continue
            record = sessions.setdefault(sess_id, {"cwd": os.getcwd(), "sessionId": sess_id})
            cwd = str(record.get("cwd") or os.getcwd())
            target_session_id = str(record.get("sessionId") or sess_id)
            thread = threading.Thread(
                target=handle_prompt,
                args=(req_id, target_session_id, text, cwd),
                daemon=True,
            )
            thread.start()
        elif method == "session/cancel":
            sess_id = str(params.get("sessionId") or "")
            cancelled = cancel_session(sess_id)
            if req_id is not None:
                reply(req_id, {"cancelled": cancelled})
        elif method == "ping":
            reply(req_id, {})
        elif req_id is not None:
            reply(req_id, {})


if __name__ == "__main__":
    if "--version" in sys.argv:
        print("dsh-acp 1.3.0")
        sys.exit(0)
    main()
