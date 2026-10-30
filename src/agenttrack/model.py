"""Row shapes shared by every source and the store. Field order equals column order."""

import re
from datetime import datetime, timezone
from typing import Literal, NamedTuple

Kind = Literal["prompt", "tool_call", "response"]

PROMPT_MAX = 500


class Thread(NamedTuple):
    thread_id: str
    harness: str
    session_id: str
    parent_thread_id: str | None
    project: str | None
    title: str | None
    model: str | None
    started_at: str | None
    source_path: str


class Event(NamedTuple):
    harness: str
    session_id: str
    thread_id: str
    project: str | None
    model: str | None
    ts: str
    kind: Kind
    tool: str | None = None
    input_tokens: int | None = None
    cached_tokens: int | None = None
    output_tokens: int | None = None
    source_path: str = ""
    text: str | None = None
    failed: int | None = None  # tool_call only: 1 failed, 0 ok, None outcome not recorded
    duration_ms: int | None = None  # tool_call only


class Edge(NamedTuple):
    child_thread_id: str
    parent_thread_id: str
    source_path: str


class Parsed(NamedTuple):
    threads: list[Thread]
    events: list[Event]
    edges: list[Edge]


def clip(text: str | None, limit: int) -> str | None:
    if text is None:
        return None
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def norm_ts(value: str | int | float) -> str:
    """UTC ISO with millisecond precision: 2026-10-10T05:20:14.824Z. Numbers are epoch seconds or ms."""
    if isinstance(value, str):
        if len(value) == 24 and value[-1] == "Z" and value[10] == "T":
            return value
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    else:
        seconds = value / 1000 if value > 1e11 else value
        dt = datetime.fromtimestamp(seconds, timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return f"{dt:%Y-%m-%dT%H:%M:%S}.{dt.microsecond // 1000:03d}Z"


def ms_between(start: str, end: str) -> int:
    """Milliseconds from one norm_ts value to a later one."""
    a, b = (datetime.strptime(t, "%Y-%m-%dT%H:%M:%S.%fZ") for t in (start, end))
    return max(0, round((b - a).total_seconds() * 1000))


# Markup patterns mirror web/src/lib/session-title.ts so stored titles and the display-side guard agree.
_META_BLOCK = re.compile(r"<(command-message|command-name|t3_context|system-reminder|local-command-[\w-]+)\b[^>]*>[\s\S]*?(?:</\1>|\Z)")
_TAG = re.compile(r"</?[a-z][\w-]*(?:\s[^>]*)?>", re.IGNORECASE)
_PARTIAL_TAG = re.compile(r"</?[a-z][\w-]*[^>]*\Z", re.IGNORECASE)
_IMAGE = re.compile(r"\[(?:Attached )?image\b[^\]]*\]?", re.IGNORECASE)
_LEADING_COMMAND = re.compile(r"^[$/][a-z][\w:.-]*(?=\s|\Z)\s*", re.IGNORECASE)
_READABLE = re.compile(r"[^\W_]{2}")
_SENTENCE_END = re.compile(r"[.?!;](?=\s|\Z)|\n")
_LOWER_WORD = re.compile(r"[a-z]+(?:['\u2019-][a-z]+)*[,:]?")
_ABBREVIATIONS = ("e.g", "i.e", "etc", "vs")
TITLE_MIN = 24


def _fit(text: str, limit: int) -> str:
    """Cut at a word boundary under limit and append an ellipsis. Never splits a URL or path: a long first word stays whole."""
    if len(text) <= limit:
        return text
    space = text.rfind(" ", 0, limit)
    if space <= 0:
        space = text.find(" ", limit)
        if space < 0:
            return text
    return text[:space].rstrip(" ,:;-") + "…"


def _command_title(raw: str, text: str) -> str | None:
    named = re.search(r"<command-name>\s*([^<\s]+)", raw)
    if named:
        return named.group(1) if named.group(1)[0] in "/$" else "/" + named.group(1)
    lead = _LEADING_COMMAND.match(text)
    return lead.group(0).strip() if lead else None


def title_from_text(text: str | None, limit: int = 80) -> str | None:
    """A short sentence-case thread title from a prompt or stored title, or None when nothing readable remains.

    Drops wrapper blocks, tags, image markers, a leading skill or slash command and a heading marker, then cuts at the first
    sentence end past TITLE_MIN characters, else at limit on a word boundary.
    """
    if not text:
        return None
    if "<task-notification" in text:
        summary = re.search(r"<summary>([^<]*)", text)
        summary = " ".join(summary.group(1).split()) if summary else ""
        return _fit(f"Task update: {summary}" if summary else "Task update", limit)
    body = _META_BLOCK.sub(" ", text)
    body = _IMAGE.sub(" ", _PARTIAL_TAG.sub("", _TAG.sub(" ", body)))
    body = "\n".join(line.strip() for line in body.splitlines())
    body = re.sub(r"\n{2,}", "\n", re.sub(r"[^\S\n]+", " ", body)).strip()
    stripped = body
    while (lead := _LEADING_COMMAND.match(stripped)) is not None:
        stripped = stripped[lead.end():]
    if not _READABLE.search(stripped):
        return _command_title(text, body)
    body = re.sub(r"^#+\s+", "", stripped).strip()
    note = re.fullmatch(r"\[([^\]]+)\]", body)
    if note:
        body = note.group(1).strip()
    for end in _SENTENCE_END.finditer(body):
        if end.start() >= TITLE_MIN and not body[: end.start() + 1].lower().endswith(_ABBREVIATIONS):
            body = body[: end.start()]
            break
    body = " ".join(body.split())
    if not _READABLE.search(body):
        return None
    if _LOWER_WORD.fullmatch(body.split(" ", 1)[0]):
        body = body[0].upper() + body[1:]
    return _fit(body, limit)
