"""Grok sessions: <home>/sessions/<urlencoded-cwd>/<sessionId>/ plus <urlencoded-cwd>/prompt_history.jsonl."""

import json
from pathlib import Path
from urllib.parse import unquote

from ..model import PROMPT_MAX, Edge, Event, Parsed, Thread, clip, norm_ts
from ..platform import Env
from .base import Cap, candidate_homes, detect_home

HARNESS = "grok"
PROCESS_NAMES = ("grok",)
DIR_MEMBERS = ("summary.json", "usage.json", "updates.jsonl", "events.jsonl")
PROMPT_HISTORY = "prompt_history.jsonl"


def units(home: Path):
    root = Path(home) / "sessions"
    for cwd_dir in sorted(p for p in root.glob("*") if p.is_dir()):
        history = cwd_dir / PROMPT_HISTORY
        if history.is_file():
            yield history
        for session in sorted(p for p in cwd_dir.glob("*") if p.is_dir()):
            yield session


def members(path: Path) -> list[Path]:
    path = Path(path)
    if path.is_dir():
        return [path / name for name in DIR_MEMBERS]
    return [path]


def _read_json(path: Path) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def _lines(path: Path, *markers: str):
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                if any(m in line for m in markers):
                    try:
                        yield json.loads(line)
                    except ValueError:
                        continue
    except OSError:
        return


def _turn_rows(totals: dict, fallback_model: str | None):
    """(model, input, cached, output) per model. Falls back to the turn totals when per-model values do not add up."""
    keys = ("inputTokens", "cachedReadTokens", "outputTokens")
    by_model = totals.get("modelUsage") or {}
    if by_model and all(sum(u.get(k) or 0 for u in by_model.values()) == (totals.get(k) or 0) for k in keys):
        return [(m, *(u.get(k) or 0 for k in keys)) for m, u in by_model.items()]
    model = totals.get("primaryModelId") or fallback_model
    return [(model, *(totals.get(k) or 0 for k in keys))]


def _parse_prompt_history(path: Path) -> Parsed:
    project = unquote(path.parent.name)
    events = []
    for d in _lines(path, '"prompt"'):
        sid = d.get("session_id")
        if not sid or not d.get("timestamp"):
            continue
        events.append(Event(HARNESS, sid, sid, project, None, norm_ts(d["timestamp"]), "prompt", text=clip(d.get("prompt"), PROMPT_MAX), source_path=str(path)))
    return Parsed([], events, [])


def parse(path: Path) -> Parsed:
    path = Path(path)
    if path.is_file():
        return _parse_prompt_history(path)
    source = str(path)
    summary = _read_json(path / "summary.json")
    session_id = (summary.get("info") or {}).get("id") or path.name
    project = (summary.get("info") or {}).get("cwd") or unquote(path.parent.name)
    model = summary.get("current_model_id")
    is_child = summary.get("session_kind") == "subagent"
    title = summary.get("generated_title") or summary.get("session_summary") or None
    created = summary.get("created_at")

    events: list[Event] = []
    edges: list[Edge] = []

    def event(ts, kind, model=None, tool=None, tokens=None, failed=None, duration_ms=None):
        i, c, o = tokens or (None, None, None)
        events.append(Event(HARNESS, session_id, session_id, project, model, ts, kind, tool, i, c, o, source, None, failed, duration_ms))

    # tool_started has no call id, so each tool_completed settles the oldest unsettled start of the same tool.
    starts: list[tuple[str, str]] = []
    outcome_of: dict[int, tuple[int, int | None]] = {}
    open_starts: dict[str, list[int]] = {}
    for d in _lines(path / "events.jsonl", '"tool_started"', '"tool_completed"'):
        if d.get("type") == "tool_started" and d.get("ts"):
            name = d.get("tool_name") or "?"
            open_starts.setdefault(name, []).append(len(starts))
            starts.append((norm_ts(d["ts"]), name))
        elif d.get("type") == "tool_completed" and open_starts.get(d.get("tool_name") or "?"):
            outcome_of[open_starts[d.get("tool_name") or "?"].pop(0)] = (int(d.get("outcome") == "error"), d.get("duration_ms"))
    for i, (ts, name) in enumerate(starts):
        failed, duration = outcome_of.get(i, (None, None))
        event(ts, "tool_call", model, name, failed=failed, duration_ms=duration)

    usage = _read_json(path / "usage.json")
    turns_floor = norm_ts(usage["updatedAt"]) if usage.get("updatedAt") else None
    if not is_child:
        for turn in usage.get("turns") or []:
            if turn.get("endedAt"):
                for m, i, c, o in _turn_rows(turn, model):
                    event(norm_ts(turn["endedAt"]), "response", m, tokens=(i, c, o))

    for d in _lines(path / "updates.jsonl", '"subagent_spawned"', '"turn_completed"'):
        update = (d.get("params") or {}).get("update") or {}
        kind = update.get("sessionUpdate")
        if kind == "subagent_spawned" and update.get("child_session_id") and update.get("parent_session_id"):
            edges.append(Edge(update["child_session_id"], update["parent_session_id"], source))
        elif kind == "turn_completed" and not is_child and update.get("usage"):
            stamp = ((d.get("params") or {}).get("_meta") or {}).get("agentTimestampMs")
            if stamp is None:
                continue
            ts = norm_ts(stamp)
            if turns_floor is None or ts > turns_floor:
                for m, i, c, o in _turn_rows(update["usage"], model):
                    event(ts, "response", m, tokens=(i, c, o))

    events.sort(key=lambda e: e.ts)
    thread = Thread(session_id, HARNESS, session_id, None, project, clip(title, 200), model, norm_ts(created) if created else None, source)
    return Parsed([thread], events, edges)


class GrokAdapter:
    id = HARNESS
    display_name = "Grok"
    capabilities = frozenset({Cap.INGEST, Cap.SUBAGENTS, Cap.TOKENS})
    process_names = PROCESS_NAMES
    rollup_edges = True

    def homes(self, env: Env) -> list[Path]:
        return candidate_homes(self.id, env, env.home / ".grok")

    def detect(self, env: Env):
        return detect_home(self.id, env, self.homes(env), ("sessions",))

    def units(self, home: Path):
        return units(home)

    def members(self, unit: Path) -> list[Path]:
        return members(unit)

    def parse(self, unit: Path) -> Parsed:
        return parse(unit)

    def titles(self, home: Path) -> dict[str, str]:
        return {}


ADAPTER = GrokAdapter()
