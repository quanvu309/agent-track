"""Codex rollouts: <home>/sessions/YYYY/MM/DD/rollout-*.jsonl, one file per thread."""

import json
import re
import sqlite3
from pathlib import Path

from ..model import PROMPT_MAX, Event, Parsed, Thread, clip, ms_between, norm_ts
from ..platform import Env, ProcessProbe, readonly_uri
from ..tail import decide_from_tail, ts as _ts
from .base import IDLE, WORKING, Cap, LiveScan, LiveSession, candidate_homes, detect_home

HARNESS = "codex"
PROCESS_NAMES = ("codex",)
# Every rollout line starts {"timestamp":..,"ordinal":N,"type":T,"payload":{"type":P ...
PEEK = re.compile(r'^\{"timestamp":"[^"]*","ordinal":\d+,"type":"([a-z_]+)"(?:,"payload":\{"type":"([a-z_]+)")?')


def units(home: Path):
    yield from sorted((Path(home) / "sessions").glob("*/*/*/rollout-*.jsonl"))


def members(path: Path) -> list[Path]:
    return [Path(path)]


def titles(home: Path) -> dict[str, str]:
    db = Path(home) / "state_5.sqlite"
    if not db.exists():
        return {}
    conn = sqlite3.connect(readonly_uri(db), uri=True)
    try:
        rows = conn.execute("SELECT id, title FROM threads WHERE title <> ''").fetchall()
    except sqlite3.Error:
        return {}
    finally:
        conn.close()
    return dict(rows)


def _wanted(top: str, inner: str | None) -> bool:
    if top == "response_item":
        return inner in ("function_call", "custom_tool_call", "custom_tool_call_output", "message")
    return top in ("session_meta", "turn_context", "token_usage_record") or (top == "event_msg" and inner == "thread_settings_applied")


def _script_verdict(output) -> int | None:
    """1 for "Script failed", 0 for "Script completed", None while running or aborted."""
    if isinstance(output, list):
        output = next((c.get("text") for c in output if isinstance(c, dict) and c.get("text")), "")
    head = output if isinstance(output, str) else ""
    return 1 if head.startswith("Script failed") else 0 if head.startswith("Script completed") else None


def parse(path: Path) -> Parsed:
    path = Path(path)
    source = str(path)
    meta = None
    model = None
    rows: list[tuple] = []  # (ts, kind, model, tool, usage, text)
    seen_responses: set[str] = set()
    outcomes: dict[str, tuple[str, int]] = {}  # call_id -> (ts, failed) for custom tool calls that finished

    with open(path, encoding="utf-8") as fh:
        for line in fh:
            peeked = PEEK.match(line)
            if peeked and not _wanted(*peeked.groups()):
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            top, payload = d.get("type"), d.get("payload") or {}
            if top == "session_meta":
                meta = meta or payload
            elif top == "turn_context":
                model = payload.get("model") or model
            elif top == "event_msg":
                if payload.get("type") == "thread_settings_applied":
                    model = (payload.get("thread_settings") or {}).get("model") or model
            elif top == "token_usage_record":
                rid = payload.get("response_id")
                usage = payload.get("usage")
                if usage is None or rid in seen_responses:
                    continue
                seen_responses.add(rid)
                rows.append((norm_ts(d["timestamp"]), "response", model, None, usage, None))
            elif top == "response_item":
                kind = payload.get("type")
                if kind in ("function_call", "custom_tool_call"):
                    rows.append((norm_ts(d["timestamp"]), "tool_call", model, payload.get("name") or "?", None, payload.get("call_id")))
                elif kind == "custom_tool_call_output":
                    verdict = _script_verdict(payload.get("output"))
                    if verdict is not None and payload.get("call_id"):
                        outcomes[payload["call_id"]] = (norm_ts(d["timestamp"]), verdict)
                elif kind == "message" and payload.get("role") == "user":
                    parts = [c.get("text") or "" for c in payload.get("content") or [] if isinstance(c, dict)]
                    parts = [p for p in parts if p and not p.startswith("<")]
                    if parts:
                        rows.append((norm_ts(d["timestamp"]), "prompt", model, None, None, "\n".join(parts)))

    if meta is None:
        return Parsed([], [], [])
    thread_id = meta["id"]
    session_id = meta.get("session_id") or thread_id
    source_kind = meta.get("source")
    is_root = isinstance(source_kind, str)
    parent = None
    if isinstance(source_kind, dict):
        parent = (((source_kind.get("subagent") or {}).get("thread_spawn")) or {}).get("parent_thread_id")
    project = meta.get("cwd")

    events: list[Event] = []
    for ts, kind, row_model, tool, usage, text in rows:
        failed = duration = None
        if kind == "prompt":
            if not is_root:
                continue
        elif kind == "tool_call":
            done = outcomes.get(text)
            text = None
            if done:
                failed, duration = done[1], ms_between(ts, done[0])
        i = c = o = None
        if usage is not None:
            i, c, o = usage.get("input_tokens") or 0, usage.get("cached_input_tokens") or 0, usage.get("output_tokens") or 0
        events.append(Event(HARNESS, session_id, thread_id, project, row_model, ts, kind, tool, i, c, o, source, clip(text, PROMPT_MAX), failed, duration))

    started = norm_ts(meta["timestamp"]) if meta.get("timestamp") else (rows[0][0] if rows else None)
    thread = Thread(thread_id, HARNESS, session_id, parent, project, None, model, started, source)
    return Parsed([thread], events, [])


LIVE_PEEK = re.compile(r'^\{"timestamp":\s*"([^"]*)",\s*"ordinal":\s*\d+,\s*"type":\s*"(event_msg|response_item)",\s*"payload":\s*\{\s*"type":\s*"([a-z_]+)"')
LIVE_STATES = {"task_started": WORKING, "task_complete": IDLE, "turn_aborted": IDLE}
PARENT_THREAD = re.compile(r'"thread_spawn"\s*:\s*\{\s*"parent_thread_id"\s*:\s*"([^"]+)"')
ROLLOUT_ID = re.compile(r"rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$")
HEAD_BYTES = 16 * 1024


def _decide(line: str) -> tuple[str, str | None] | None:
    peek = LIVE_PEEK.match(line)
    if not peek:
        return None
    stamp, kind, payload_type = peek.groups()
    if kind == "event_msg":
        state = LIVE_STATES.get(payload_type)
        return (state, _ts(stamp)) if state else None
    if payload_type != "message":
        return None
    try:
        payload = json.loads(line).get("payload")
    except (ValueError, AttributeError):
        return None
    return (WORKING, _ts(stamp)) if isinstance(payload, dict) and payload.get("role") == "user" else None


def _parent_thread(path: Path) -> str | None:
    """Parent thread id named by a child rollout's first line (session_meta); None for a root thread or on any error."""
    try:
        with open(path, "rb") as fh:
            match = PARENT_THREAD.search(fh.readline(HEAD_BYTES).decode("utf-8", "replace"))
    except OSError:
        return None
    return match.group(1) if match else None


def live(home: Path, probe: ProcessProbe) -> LiveScan:
    """Codex processes hold every open thread's rollout file as an open fd; the newest turn record says working or idle."""
    pids = probe.find(PROCESS_NAMES)
    if pids is None:
        return LiveScan([], False)
    held: dict[str, tuple[Path, int]] = {}
    for pid in pids:
        for target in probe.open_files(pid):
            target = target.removesuffix(" (deleted)")
            match = ROLLOUT_ID.search(target)
            if match:
                held.setdefault(match.group(1), (Path(target), pid))
    found = {}
    for thread_id, (path, pid) in held.items():
        state, since = decide_from_tail(path, _decide, (IDLE, None))
        found[thread_id] = LiveSession(thread_id, state, since, pid, {})
    for thread_id, (path, _) in held.items():
        if found[thread_id].state != WORKING:
            continue
        parent = found.get(_parent_thread(path) or "")
        if parent is not None and parent.state == IDLE:
            found[parent.session_id] = parent._replace(state=WORKING, since=found[thread_id].since)  # the parent is busy while its child runs
    return LiveScan([s._replace(threads={s.session_id: s.state}) for s in found.values()], True)


class CodexAdapter:
    id = HARNESS
    display_name = "Codex"
    capabilities = frozenset({Cap.INGEST, Cap.SUBAGENTS, Cap.TITLES, Cap.TOKENS, Cap.LIVE})
    process_names = PROCESS_NAMES

    def homes(self, env: Env) -> list[Path]:
        configured = env.environ.get("CODEX_HOME")
        return candidate_homes(self.id, env, *([Path(configured)] if configured else []), env.home / ".codex")

    def detect(self, env: Env):
        return detect_home(self.id, env, self.homes(env), ("sessions",))

    def units(self, home: Path):
        return units(home)

    def members(self, unit: Path) -> list[Path]:
        return members(unit)

    def parse(self, unit: Path) -> Parsed:
        return parse(unit)

    def titles(self, home: Path) -> dict[str, str]:
        return titles(home)

    def live(self, home: Path, probe: ProcessProbe) -> LiveScan:
        return live(home, probe)


ADAPTER = CodexAdapter()
