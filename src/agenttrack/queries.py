"""Read-only queries behind the CLI report and the JSON API. Each takes a connection and returns plain data."""

import math
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import NamedTuple

from .model import norm_ts

DAY = "date(ts, 'localtime')"
HOUR = "CAST(strftime('%H', ts, 'localtime') AS INT)"
TOKENS = "COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(cached_tokens),0) AS cached_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens"
COUNTS = "SUM(kind='prompt') AS prompts, SUM(kind='tool_call') AS tool_calls, SUM(kind='response') AS responses"
FAILED = "COALESCE(SUM(failed),0) AS failed_tools"

# An idle gap longer than this between two events of a session does not count as active time.
IDLE_GAP_SECONDS = 300

# Tools that wait on a person, so their latency says nothing about the tool.
HUMAN_WAIT_TOOLS = ("AskUserQuestion", "ask_user_question", "request_user_input_async", "wait_agent", "wait", "sleep")


class Range(NamedTuple):
    """Inclusive window of local dates over event timestamps. Either end may be None."""

    since: str | None = None
    until: str | None = None

    @property
    def active(self) -> bool:
        return self.since is not None or self.until is not None

    def where(self, col: str = "ts") -> tuple[str, list]:
        day = f"date({col}, 'localtime')"
        return f"(? IS NULL OR {day} >= ?) AND (? IS NULL OR {day} <= ?)", [self.since, self.since, self.until, self.until]


ALL_TIME = Range()

# One row per root session: when it started, where, what it is called, how many threads it spans.
SESSIONS = """
  SELECT session_id, harness, MIN(started_at) AS started,
         COALESCE(MAX(CASE WHEN thread_id = session_id THEN project END), MAX(project)) AS project,
         MAX(CASE WHEN thread_id = session_id THEN title END) AS title, COUNT(*) AS threads
  FROM threads GROUP BY harness, session_id"""


def activity(rng: Range = ALL_TIME) -> tuple[str, list]:
    """One row per root session: everything its threads did inside the range, as (sql, params)."""
    where, params = rng.where()
    sql = f"""
      SELECT session_id, MIN(ts) AS first_ts, MAX(ts) AS last_ts, {TOKENS}, {COUNTS}, {FAILED},
             group_concat(DISTINCT model) AS models
      FROM events WHERE {where} GROUP BY session_id"""
    return sql, params


def _rows(conn, sql, params=()):
    return [dict(r) for r in conn.execute(sql, params)]


def _meta(conn, key):
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row[0] if row else None


def totals(conn, rng: Range = ALL_TIME) -> list[dict]:
    where, params = rng.where()
    if rng.active:
        counted = f"SELECT harness, COUNT(DISTINCT session_id) AS sessions FROM events WHERE {where} GROUP BY harness"
        sessions = f"SELECT k.harness, COALESCE(c.sessions, 0) AS sessions FROM (SELECT DISTINCT harness FROM threads) k LEFT JOIN ({counted}) c USING (harness)"
        sessions_params = params
    else:
        sessions, sessions_params = "SELECT harness, COUNT(DISTINCT session_id) AS sessions FROM threads GROUP BY harness", []
    return _rows(
        conn,
        f"""SELECT h.harness, h.sessions, COALESCE(e.input_tokens,0) AS input_tokens, COALESCE(e.cached_tokens,0) AS cached_tokens,
                   COALESCE(e.output_tokens,0) AS output_tokens, COALESCE(e.prompts,0) AS prompts,
                   COALESCE(e.tool_calls,0) AS tool_calls, COALESCE(e.responses,0) AS responses, COALESCE(e.failed_tools,0) AS failed_tools
            FROM ({sessions}) h
            LEFT JOIN (SELECT harness, {TOKENS}, {COUNTS}, {FAILED} FROM events WHERE {where} GROUP BY harness) e USING (harness)
            ORDER BY h.harness""",
        sessions_params + params,
    )


def summary(conn, rng: Range = ALL_TIME) -> dict:
    ms = _meta(conn, "last_ingest_ms")
    return {"harnesses": totals(conn, rng), "last_ingest": _meta(conn, "last_ingest"), "ingest_ms": int(ms) if ms else None}


def daily(conn) -> list[dict]:
    activity_rows = _rows(conn, f"SELECT {DAY} AS day, harness, {TOKENS}, {COUNTS} FROM events GROUP BY day, harness")
    started = {
        (r["day"], r["harness"]): r["sessions"]
        for r in conn.execute("SELECT date(started, 'localtime') AS day, harness, COUNT(*) AS sessions FROM (" + SESSIONS + ") WHERE started IS NOT NULL GROUP BY day, harness")
    }
    rows = {(r["day"], r["harness"]): {**r, "sessions": started.pop((r["day"], r["harness"]), 0)} for r in activity_rows}
    for (day, harness), n in started.items():
        rows[(day, harness)] = {"day": day, "harness": harness, "sessions": n, "input_tokens": 0, "cached_tokens": 0, "output_tokens": 0, "prompts": 0, "tool_calls": 0, "responses": 0}
    return [rows[k] for k in sorted(rows)]


def hourly(conn, day: str | None = None) -> dict:
    """One row per (local hour, harness) with events on a local day, which defaults to the server's today."""
    day = day or conn.execute("SELECT date('now', 'localtime')").fetchone()[0]
    rows = _rows(
        conn,
        f"""SELECT {HOUR} AS hour, harness, COUNT(DISTINCT session_id) AS sessions, {COUNTS}, {TOKENS}
            FROM events WHERE {DAY} = ? GROUP BY hour, harness ORDER BY hour, harness""",
        (day,),
    )
    return {"day": day, "rows": rows}


def models(conn, rng: Range = ALL_TIME) -> list[dict]:
    where, params = rng.where()
    return _rows(
        conn,
        f"""SELECT harness, COALESCE(model, '(unknown)') AS model, {TOKENS}, SUM(kind='response') AS responses
            FROM events WHERE kind = 'response' AND {where} GROUP BY harness, model ORDER BY harness, input_tokens DESC""",
        params,
    )


def tools(conn, harness: str | None = None, limit: int = 20, rng: Range = ALL_TIME) -> list[dict]:
    where, params = rng.where()
    return _rows(
        conn,
        f"""SELECT harness, tool, COUNT(*) AS calls FROM events WHERE kind = 'tool_call' AND (? IS NULL OR harness = ?) AND {where}
            GROUP BY harness, tool ORDER BY calls DESC, tool LIMIT ?""",
        [harness, harness, *params, limit],
    )


def _percentile(sorted_values: list[int], q: float) -> int:
    return sorted_values[min(len(sorted_values) - 1, int(q * len(sorted_values)))]


def reliability(conn, harness: str | None = None, limit: int = 15, rng: Range = ALL_TIME) -> dict:
    """Tool outcomes. 'known' counts calls whose result the source recorded, failure rate is failed / known."""
    where, params = rng.where()
    base = f"kind = 'tool_call' AND (? IS NULL OR harness = ?) AND {where}"
    args = [harness, harness, *params]
    per_harness = _rows(
        conn,
        f"""SELECT harness, COUNT(*) AS calls, COUNT(failed) AS known, COALESCE(SUM(failed),0) AS failed, ROUND(AVG(duration_ms)) AS avg_ms
            FROM events WHERE {base} GROUP BY harness ORDER BY harness""",
        args,
    )
    latencies: dict[tuple[str, str], list[int]] = {}
    for r in conn.execute(f"SELECT harness, tool, duration_ms FROM events WHERE {base} AND duration_ms IS NOT NULL", args):
        latencies.setdefault((r[0], r[1]), []).append(r[2])
    per_tool = _rows(
        conn,
        f"""SELECT harness, tool, COUNT(*) AS calls, COUNT(failed) AS known, COALESCE(SUM(failed),0) AS failed
            FROM events WHERE {base} GROUP BY harness, tool HAVING known > 0""",
        args,
    )
    for row in per_tool:
        values = sorted(latencies.get((row["harness"], row["tool"]), []))
        row["avg_ms"] = round(sum(values) / len(values)) if values else None
        row["p95_ms"] = _percentile(values, 0.95) if values else None
    most_failing = sorted((r for r in per_tool if r["failed"]), key=lambda r: (-r["failed"], r["harness"], r["tool"]))[:limit]
    slowest = sorted((r for r in per_tool if r["p95_ms"] is not None and r["known"] >= 5 and r["tool"] not in HUMAN_WAIT_TOOLS), key=lambda r: -r["p95_ms"])[:limit]
    return {"harnesses": per_harness, "most_failing": most_failing, "slowest": slowest}


def heatmap(conn, harness: str | None = None, rng: Range = ALL_TIME) -> list[dict]:
    """Event counts by local weekday (0 = Sunday) and hour. Only cells with activity are returned."""
    where, params = rng.where()
    return _rows(
        conn,
        f"""SELECT CAST(strftime('%w', ts, 'localtime') AS INT) AS weekday, {HOUR} AS hour,
                   COUNT(*) AS events, SUM(kind='prompt') AS prompts
            FROM events WHERE (? IS NULL OR harness = ?) AND {where} GROUP BY weekday, hour ORDER BY weekday, hour""",
        [harness, harness, *params],
    )


def projects(conn, harness: str | None = None, limit: int = 200, rng: Range = ALL_TIME) -> list[dict]:
    act, act_params = activity(rng)
    return _rows(
        conn,
        f"""SELECT COALESCE(s.project, '(none)') AS project, COUNT(*) AS sessions, group_concat(DISTINCT s.harness) AS harnesses,
                   SUM(a.input_tokens) AS input_tokens, SUM(a.cached_tokens) AS cached_tokens, SUM(a.output_tokens) AS output_tokens,
                   SUM(a.prompts) AS prompts, SUM(a.tool_calls) AS tool_calls, SUM(a.failed_tools) AS failed_tools, MAX(a.last_ts) AS last_active
            FROM ({SESSIONS}) s JOIN ({act}) a USING (session_id)
            WHERE (? IS NULL OR s.harness = ?)
            GROUP BY s.project ORDER BY last_active DESC LIMIT ?""",
        [*act_params, harness, harness, limit],
    )


def _like(term: str) -> str:
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


SESSION_COLUMNS = """s.session_id, s.harness, s.project, s.title, s.threads, s.started, a.first_ts AS first, a.last_ts AS last, a.models,
                   a.input_tokens, a.cached_tokens, a.output_tokens, a.prompts, a.tool_calls, a.failed_tools"""


def _active_seconds(conn, session_ids: list[str], rng: Range) -> dict[str, int]:
    """Seconds between consecutive events of a session, ignoring idle gaps over IDLE_GAP_SECONDS."""
    if not session_ids:
        return {}
    where, params = rng.where()
    marks = ",".join("?" * len(session_ids))
    rows = conn.execute(
        f"""SELECT session_id, CAST(ROUND(SUM(CASE WHEN gap <= ? THEN gap ELSE 0 END)) AS INT) FROM (
              SELECT session_id, (julianday(ts) - julianday(LAG(ts) OVER (PARTITION BY session_id ORDER BY ts))) * 86400 AS gap
              FROM events WHERE session_id IN ({marks}) AND {where}) GROUP BY session_id""",
        [IDLE_GAP_SECONDS, *session_ids, *params],
    )
    return {r[0]: r[1] or 0 for r in rows}


def sessions(conn, harness: str | None = None, project: str | None = None, limit: int = 50, rng: Range = ALL_TIME, q: str | None = None) -> list[dict]:
    """Matches q against the session title, project path and the text of its prompts."""
    act, act_params = activity(rng)
    like = _like(q) if q else None
    rows = _rows(
        conn,
        f"""SELECT {SESSION_COLUMNS}
            FROM ({SESSIONS}) s JOIN ({act}) a USING (session_id)
            WHERE (? IS NULL OR s.harness = ?) AND (? IS NULL OR s.project = ?)
              AND (? IS NULL OR s.title LIKE ? ESCAPE '\\' OR s.project LIKE ? ESCAPE '\\'
                   OR EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.session_id AND e.kind = 'prompt' AND e.text LIKE ? ESCAPE '\\'))
            ORDER BY a.last_ts DESC LIMIT ?""",
        [*act_params, harness, harness, project, project, like, like, like, like, limit],
    )
    active = _active_seconds(conn, [r["session_id"] for r in rows], rng)
    for r in rows:
        r["active_s"] = active.get(r["session_id"], 0)
    return rows


def live(conn, minutes: int = 15, now: datetime | None = None) -> list[dict]:
    """Root sessions with an event in the last `minutes`, most recent first."""
    now = now or datetime.now(timezone.utc)
    cutoff = (now - timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    rows = _rows(
        conn,
        f"""SELECT {SESSION_COLUMNS}, r.recent_events, r.recent_input, r.recent_output, r.recent_failed, r.recent_tool_calls
            FROM ({SESSIONS}) s
            JOIN (SELECT session_id, MIN(ts) AS first_ts, MAX(ts) AS last_ts, {TOKENS}, {COUNTS}, {FAILED}, group_concat(DISTINCT model) AS models
                  FROM events GROUP BY session_id) a USING (session_id)
            JOIN (SELECT session_id, COUNT(*) AS recent_events, COALESCE(SUM(input_tokens),0) AS recent_input,
                         COALESCE(SUM(output_tokens),0) AS recent_output, COALESCE(SUM(failed),0) AS recent_failed,
                         COALESCE(SUM(kind='tool_call'),0) AS recent_tool_calls
                  FROM events WHERE ts >= ? GROUP BY session_id) r USING (session_id)
            ORDER BY a.last_ts DESC""",
        (cutoff,),
    )
    active = _active_seconds(conn, [r["session_id"] for r in rows], ALL_TIME)
    for r in rows:
        r["active_s"] = active.get(r["session_id"], 0)
        r["thread_rows"] = []
    if rows:
        ids = [r["session_id"] for r in rows]
        marks = ",".join("?" * len(ids))
        by_session: dict[str, list] = {}
        for t in _rows(
            conn,
            f"""SELECT t.session_id, t.thread_id, t.parent_thread_id, t.title, t.model, t.started_at, t.project,
                       COALESCE(e.input_tokens,0) AS input_tokens, COALESCE(e.output_tokens,0) AS output_tokens,
                       COALESCE(e.tool_calls,0) AS tool_calls, COALESCE(e.failed_tools,0) AS failed_tools, e.last_ts AS last,
                       COALESCE(e.recent_events,0) AS recent_events, COALESCE(e.recent_tool_calls,0) AS recent_tool_calls
                FROM threads t LEFT JOIN (
                  SELECT session_id, thread_id, {TOKENS}, {COUNTS}, {FAILED}, MAX(ts) AS last_ts,
                         COALESCE(SUM(ts >= ?),0) AS recent_events, COALESCE(SUM(ts >= ? AND kind = 'tool_call'),0) AS recent_tool_calls
                  FROM events WHERE session_id IN ({marks}) GROUP BY session_id, thread_id) e
                  ON e.session_id = t.session_id AND e.thread_id = t.thread_id
                WHERE t.session_id IN ({marks})
                ORDER BY t.started_at IS NULL, t.started_at, t.thread_id""",
            (cutoff, cutoff, *ids, *ids),
        ):
            by_session.setdefault(t.pop("session_id"), []).append(t)
        for r in rows:
            r["thread_rows"] = by_session.get(r["session_id"], [])
    return rows


def session(conn, session_id: str, timeline: int = 300) -> dict | None:
    act, act_params = activity()
    meta = _rows(
        conn,
        f"""SELECT {SESSION_COLUMNS}
            FROM ({SESSIONS}) s LEFT JOIN ({act}) a USING (session_id) WHERE s.session_id = ?""",
        [*act_params, session_id],
    )
    if not meta:
        return None
    meta[0]["active_s"] = _active_seconds(conn, [session_id], ALL_TIME).get(session_id, 0)
    thread_rows = _rows(
        conn,
        f"""SELECT t.thread_id, t.parent_thread_id, t.title, t.model, t.started_at, t.project,
                   COALESCE(e.input_tokens,0) AS input_tokens, COALESCE(e.output_tokens,0) AS output_tokens,
                   COALESCE(e.tool_calls,0) AS tool_calls, COALESCE(e.failed_tools,0) AS failed_tools, e.last_ts AS last
            FROM threads t LEFT JOIN (SELECT thread_id, {TOKENS}, {COUNTS}, {FAILED}, MAX(ts) AS last_ts FROM events WHERE session_id = ? GROUP BY thread_id) e
              USING (thread_id)
            WHERE t.session_id = ? ORDER BY t.started_at""",
        (session_id, session_id),
    )
    by_model = _rows(
        conn,
        f"""SELECT COALESCE(model,'(unknown)') AS model, {TOKENS}, COUNT(*) AS responses FROM events
            WHERE session_id = ? AND kind = 'response' GROUP BY model ORDER BY input_tokens DESC""",
        (session_id,),
    )
    top_tools = _rows(
        conn,
        """SELECT tool, COUNT(*) AS calls, COALESCE(SUM(failed),0) AS failed, ROUND(AVG(duration_ms)) AS avg_ms
           FROM events WHERE session_id = ? AND kind = 'tool_call' GROUP BY tool ORDER BY calls DESC LIMIT 15""",
        (session_id,),
    )
    events = _rows(
        conn,
        """SELECT ts, kind, thread_id, model, tool, input_tokens, cached_tokens, output_tokens, failed, duration_ms, substr(text, 1, 300) AS text
           FROM events WHERE session_id = ? ORDER BY ts DESC LIMIT ?""",
        (session_id, timeline),
    )
    events.reverse()
    return {"session": meta[0], "threads": thread_rows, "models": by_model, "tools": top_tools, "events": events}


BURN_BUCKETS = (1, 5, 15, 60)
MACHINE_POINTS = 300


def _epoch_bucket(width: int, col: str = "ts") -> str:
    """UTC epoch seconds of `col` rounded down to a multiple of `width`. Our ts strings end in Z, so this ignores TZ."""
    return f"CAST(strftime('%s', {col}) AS INT) / {int(width)} * {int(width)}"


def burn(conn, minutes: int = 120, bucket: int = 5, harness: str | None = None, now: datetime | None = None) -> dict:
    """Token use per UTC bucket and harness. The window starts `minutes` before now, rounded down to a bucket boundary."""
    width = bucket * 60
    until = (now or datetime.now(timezone.utc)).timestamp()
    since = (until - minutes * 60) // width * width
    rows = _rows(
        conn,
        f"""SELECT strftime('%Y-%m-%dT%H:%M:%S.000Z', {_epoch_bucket(width, 'events.ts')}, 'unixepoch') AS ts, harness, {TOKENS}, {COUNTS}
            FROM events WHERE events.ts >= ? AND events.ts <= ? AND (? IS NULL OR harness = ?)
            GROUP BY {_epoch_bucket(width, 'events.ts')}, harness ORDER BY 1, harness""",
        (norm_ts(since), norm_ts(until), harness, harness),
    )
    return {"bucket_minutes": bucket, "since": norm_ts(since), "until": norm_ts(until), "rows": rows}


def machine_series(conn, minutes: int = 60, now: datetime | None = None) -> dict:
    """Machine samples averaged into equal UTC buckets, at most about MACHINE_POINTS of them. Agent memory is averaged
    over every sample in the bucket, so a harness that was not running counts as 0."""
    width = max(15, math.ceil(minutes * 60 / MACHINE_POINTS))
    since = norm_ts((now or datetime.now(timezone.utc)).timestamp() - minutes * 60)
    samples = conn.execute(
        f"""SELECT {_epoch_bucket(width)} AS b, COUNT(*), AVG(mem_used), AVG(swap_used), AVG(cpu_pct), AVG(load1)
            FROM machine_samples WHERE ts >= ? GROUP BY b ORDER BY b""",
        (since,),
    ).fetchall()
    agents: dict[int, dict] = {}
    for b, harness, total in conn.execute(
        f"SELECT {_epoch_bucket(width)} AS b, harness, SUM(mem) FROM machine_agent WHERE ts >= ? GROUP BY b, harness ORDER BY b, harness", (since,)
    ):
        agents.setdefault(b, {})[harness] = total
    rounded = lambda value, digits=None: None if value is None else round(value, digits)
    series = [
        {"ts": norm_ts(b), "mem_used": rounded(mem), "swap_used": rounded(swap), "cpu_pct": rounded(cpu, 1), "load1": rounded(load, 2),
         "agents": {h: round(mem / n) for h, mem in agents.get(b, {}).items()}}
        for b, n, mem, swap, cpu, load in samples
    ]
    return {"bucket_seconds": width, "series": series}


def cli_report(conn) -> dict:
    """Numbers printed by `ingest`: totals, per-day counts, tokens per harness and model."""
    return {"totals": totals(conn), "daily": daily(conn), "models": models(conn)}
