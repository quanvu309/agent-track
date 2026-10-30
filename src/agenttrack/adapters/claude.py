"""Claude Code transcripts: <home>/projects/<slug>/<sessionId>.jsonl and <sessionId>/subagents/**/agent-*.jsonl."""

import json
import re
import time
from pathlib import Path

from ..model import PROMPT_MAX, Event, Parsed, Thread, clip, ms_between, norm_ts, title_from_text
from ..platform import Env, ProcessProbe
from ..tail import decide_from_tail, ts as _ts
from .base import ENDED, IDLE, WORKING, Cap, LiveScan, LiveSession, candidate_homes, detect_home

HARNESS = "claude"
PROCESS_NAMES = ("claude",)
SUBAGENT_STALE_S = 20 * 60  # a sub-agent killed mid-tool leaves a busy-looking tail forever; quiet this long means it is gone
CLAUDE_TURN = re.compile(r'"type"\s*:\s*"(?:api-request|user|assistant)"')
WANTED = re.compile(r'"type"\s*:\s*"(?:assistant|user|ai-title)"')


def units(home: Path):
    root = Path(home) / "projects"
    yield from sorted(root.glob("*/*.jsonl"))
    yield from sorted(root.glob("*/*/subagents/**/agent-*.jsonl"))


def members(path: Path) -> list[Path]:
    return [Path(path)]


def _subagent_description(path: Path) -> str | None:
    """The `description` the parent gave this sub-agent, from the agent-<id>.meta.json next to its transcript."""
    try:
        with open(path.with_name(path.stem + ".meta.json"), encoding="utf-8") as fh:
            description = json.load(fh).get("description")
    except (OSError, ValueError, AttributeError):
        return None
    return " ".join(description.split()) if isinstance(description, str) and description.strip() else None


def _prompt_text(message: dict) -> str | None:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return None
    texts = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "tool_result":
            return None
        if block.get("type") == "text":
            texts.append(block.get("text") or "")
    return "\n".join(texts) if texts else None


def parse(path: Path) -> Parsed:
    path = Path(path)
    source = str(path)
    is_sub = path.name.startswith("agent-") and "subagents" in path.parts
    session_id = agent_id = project = title = first_ts = first_user = None
    # message.id -> (earliest ts, line with max output_tokens)
    messages: dict[str, tuple[str, dict]] = {}
    tool_ids: set[str] = set()
    tool_calls: list[tuple[str, str, str | None, str | None]] = []
    results: dict[str, tuple[str, bool]] = {}  # tool_use_id -> (ts, is_error)
    prompts: list[tuple[str, str]] = []

    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if not WANTED.search(line):
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            kind = d.get("type")
            if kind not in ("assistant", "user", "ai-title"):
                continue
            session_id = session_id or d.get("sessionId")
            agent_id = agent_id or d.get("agentId")
            project = project or d.get("cwd")
            if kind == "ai-title":
                title = d.get("aiTitle") or title
                continue
            ts = norm_ts(d["timestamp"]) if d.get("timestamp") else None
            if ts and (first_ts is None or ts < first_ts):
                first_ts = ts
            message = d.get("message") or {}
            if kind == "user":
                if d.get("isMeta") or ts is None:
                    continue
                if isinstance(message.get("content"), list):
                    for block in message["content"]:
                        if isinstance(block, dict) and block.get("type") == "tool_result" and block.get("tool_use_id"):
                            results[block["tool_use_id"]] = (ts, bool(block.get("is_error")))
                text = _prompt_text(message)
                if text is None:
                    continue
                if first_user is None:
                    first_user = text
                if not is_sub:
                    prompts.append((ts, text))
                continue
            if ts is None:
                continue
            key = message.get("id") or d.get("uuid")
            held = messages.get(key)
            output = (message.get("usage") or {}).get("output_tokens") or 0
            if held is None:
                messages[key] = (ts, d)
            else:
                held_ts, held_line = held
                held_out = (held_line["message"].get("usage") or {}).get("output_tokens") or 0
                messages[key] = (min(held_ts, ts), d if output > held_out else held_line)
            content = message.get("content")
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("id") not in tool_ids:
                        tool_ids.add(block.get("id"))
                        tool_calls.append((ts, block.get("name") or "?", message.get("model"), block.get("id")))

    if not session_id:
        return Parsed([], [], [])
    thread_id = (agent_id or path.stem.removeprefix("agent-")) if is_sub else session_id
    model = None
    events: list[Event] = []

    def event(ts, kind, model=None, tool=None, usage=None, text=None, failed=None, duration_ms=None):
        i = c = o = None
        if usage is not None:
            c = usage.get("cache_read_input_tokens") or 0
            i = (usage.get("input_tokens") or 0) + (usage.get("cache_creation_input_tokens") or 0) + c
            o = usage.get("output_tokens") or 0
        events.append(Event(HARNESS, session_id, thread_id, project, model, ts, kind, tool, i, c, o, source, text, failed, duration_ms))

    for ts, text in prompts:
        event(ts, "prompt", text=clip(text, PROMPT_MAX))
    for ts, name, tool_model, tool_id in tool_calls:
        done = results.get(tool_id)
        event(ts, "tool_call", model=tool_model, tool=name, failed=None if done is None else int(done[1]), duration_ms=None if done is None else ms_between(ts, done[0]))
    for ts, line in messages.values():
        usage = line["message"].get("usage")
        if usage is None or line["message"].get("model") == "<synthetic>":
            continue
        model = line["message"].get("model")
        event(ts, "response", model=model, usage=usage)
    events.sort(key=lambda e: e.ts)

    if is_sub:
        title = _subagent_description(path) or title_from_text(title or first_user)
    else:
        title = title_from_text(title, 200)
    thread = Thread(thread_id, HARNESS, session_id, session_id if is_sub else None, project, title, model, first_ts, source)
    return Parsed([thread], events, [])


def _interrupted(message: dict) -> bool:
    content = message.get("content")
    if isinstance(content, list):
        content = next((b.get("text") for b in content if isinstance(b, dict) and b.get("type") == "text"), None)
    return isinstance(content, str) and content.startswith("[Request interrupted by user")


def _decide(line: str) -> tuple[str, str | None] | None:
    if not CLAUDE_TURN.search(line):
        return None
    try:
        d = json.loads(line)
    except ValueError:
        return None
    if not isinstance(d, dict):
        return None
    kind = d.get("type")
    since = _ts(d.get("timestamp"))
    if kind == "api-request":
        return WORKING, since
    if kind == "user":
        if d.get("isMeta"):
            return None
        message = d.get("message")
        return (IDLE if isinstance(message, dict) and _interrupted(message) else WORKING), since
    if kind == "assistant":
        message = d.get("message")
        reason = message.get("stop_reason") if isinstance(message, dict) else None
        if reason is None or reason in ("tool_use", "max_tokens"):
            return WORKING, since
        return IDLE, since
    return None


def _tail_state(path: Path) -> tuple[str, str | None]:
    return decide_from_tail(path, _decide, (IDLE, None))


def _registry(home: Path) -> list[dict]:
    rows = []
    for path in sorted((Path(home) / "sessions").glob("*.json")):
        try:
            d = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(d, dict) and isinstance(d.get("pid"), int) and isinstance(d.get("sessionId"), str):
                rows.append(d)
        except (OSError, ValueError):
            continue
    return rows


def _transcript(home: Path, session_id: str) -> Path | None:
    found = []
    for path in (Path(home) / "projects").glob(f"*/{session_id}.jsonl"):
        try:
            found.append((path.stat().st_mtime_ns, path))
        except OSError:
            continue
    return max(found)[1] if found else None


def _subagent(meta: Path, started_at, now: float) -> tuple[str, str | None] | None:
    """State and since of one sub-agent from its meta file and sibling transcript; None when the meta is unreadable.

    Ended: finished, no transcript, transcript older than the owning process (it died with a previous pid), last turn
    complete (a sub-agent never waits on a person), or busy but silent for SUBAGENT_STALE_S.
    """
    try:
        if json.loads(meta.read_text(encoding="utf-8")).get("finished"):
            return ENDED, None
    except (OSError, ValueError, AttributeError):
        return None
    log = meta.with_name(meta.name.removesuffix(".meta.json") + ".jsonl")
    try:
        mtime = log.stat().st_mtime
    except OSError:
        return ENDED, None
    if isinstance(started_at, (int, float)) and mtime < started_at / 1000:
        return ENDED, None
    state, since = _tail_state(log)
    if state != WORKING or now - mtime > SUBAGENT_STALE_S:
        return ENDED, since
    return WORKING, since


def live(home: Path, probe: ProcessProbe) -> LiveScan:
    """Claude Code keeps <home>/sessions/<pid>.json per process; the pid is alive when its start time still matches."""
    registry = _registry(home)
    covered = any((Path(home) / "sessions").glob("*.json"))
    alive: dict[str, dict] = {}
    for d in registry:
        start = probe.start_time(d["pid"])
        if start is None or (probe.exact_start_time and start != str(d.get("procStart"))):
            continue
        started = d.get("startedAt")
        if not probe.exact_start_time and isinstance(started, (int, float)) and int(start) > started / 1000 + 5:
            continue  # the pid now belongs to a process created after this session began, so the registry file is stale
        best = alive.get(d["sessionId"])
        if best is None or (d.get("startedAt") or 0) >= (best.get("startedAt") or 0):
            alive[d["sessionId"]] = d
    sessions = []
    now = time.time()
    for session_id, d in alive.items():
        transcript = _transcript(home, session_id)
        state, since = _tail_state(transcript) if transcript else (IDLE, None)
        threads: dict[str, str] = {}
        if transcript is not None:
            working_since = []
            for meta in (transcript.parent / session_id / "subagents").glob("**/agent-*.meta.json"):
                state_since = _subagent(meta, d.get("startedAt"), now)
                if state_since is not None:
                    threads[meta.name.removeprefix("agent-").removesuffix(".meta.json")] = state_since[0]
                    if state_since[0] == WORKING:
                        working_since.append(state_since[1] or "")
            if state == IDLE and working_since:
                # The turn ended but background sub-agents are still running: the session is busy.
                state, since = WORKING, max(working_since) or None
        sessions.append(LiveSession(session_id, state, since, d["pid"], threads))
    return LiveScan(sessions, covered)


class ClaudeAdapter:
    id = HARNESS
    display_name = "Claude Code"
    capabilities = frozenset({Cap.INGEST, Cap.SUBAGENTS, Cap.TITLES, Cap.TOKENS, Cap.LIVE})
    process_names = PROCESS_NAMES

    def homes(self, env: Env) -> list[Path]:
        configured = env.environ.get("CLAUDE_CONFIG_DIR")
        return candidate_homes(self.id, env, *([Path(configured)] if configured else []), env.home / ".claude")

    def detect(self, env: Env):
        return detect_home(self.id, env, self.homes(env), ("projects",))

    def units(self, home: Path):
        return units(home)

    def members(self, unit: Path) -> list[Path]:
        return members(unit)

    def parse(self, unit: Path) -> Parsed:
        return parse(unit)

    def titles(self, home: Path) -> dict[str, str]:
        return {}

    def live(self, home: Path, probe: ProcessProbe) -> LiveScan:
        return live(home, probe)


ADAPTER = ClaudeAdapter()
