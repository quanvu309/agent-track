"""Own SQLite store and the idempotent ingest that fills it from the adapters."""

import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

from .adapters import Cap, load_adapters, resolve_homes
from .model import Edge, Event, Thread, title_from_text
from .platform import Env, readonly_uri

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, harness TEXT NOT NULL, size INT NOT NULL, mtime_ns INT NOT NULL, parsed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS threads (
  thread_id TEXT PRIMARY KEY, harness TEXT NOT NULL, session_id TEXT NOT NULL, parent_thread_id TEXT,
  project TEXT, title TEXT, model TEXT, started_at TEXT, source_path TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS edges (
  child_thread_id TEXT PRIMARY KEY, parent_thread_id TEXT NOT NULL, source_path TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  harness TEXT NOT NULL, session_id TEXT NOT NULL, thread_id TEXT NOT NULL, project TEXT, model TEXT,
  ts TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('prompt','tool_call','response')), tool TEXT,
  input_tokens INT, cached_tokens INT, output_tokens INT, source_path TEXT NOT NULL, text TEXT, failed INT, duration_ms INT);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS machine_samples (
  ts TEXT PRIMARY KEY, mem_total INT, mem_used INT, mem_available INT, swap_total INT, swap_used INT, cpu_pct REAL,
  load1 REAL, load5 REAL, load15 REAL, disk_used INT, disk_total INT, procs INT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS machine_agent (
  ts TEXT NOT NULL, harness TEXT NOT NULL, mem INT NOT NULL, procs INT NOT NULL, PRIMARY KEY (ts, harness)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS events_harness_ts ON events (harness, ts);
CREATE INDEX IF NOT EXISTS events_session ON events (session_id);
CREATE INDEX IF NOT EXISTS events_source ON events (source_path);
CREATE INDEX IF NOT EXISTS events_thread ON events (thread_id);
CREATE INDEX IF NOT EXISTS threads_session ON threads (session_id);
CREATE INDEX IF NOT EXISTS threads_source ON threads (source_path);
CREATE INDEX IF NOT EXISTS edges_source ON edges (source_path);
"""

OWNED_TABLES = ("events", "threads", "edges")

# Bump when a source starts extracting more from the same files. Every unit is then reparsed once.
PARSE_VERSION = "3"


def _migrate(conn) -> None:
    have = {r[1] for r in conn.execute("PRAGMA table_info(events)")}
    for column in ("failed", "duration_ms"):
        if column not in have:
            conn.execute(f"ALTER TABLE events ADD COLUMN {column} INT")
    if "rss" in {r[1] for r in conn.execute("PRAGMA table_info(machine_agent)")}:
        conn.execute("ALTER TABLE machine_agent RENAME COLUMN rss TO mem")
    row = conn.execute("SELECT value FROM meta WHERE key='parse_version'").fetchone()
    if row is None or row[0] != PARSE_VERSION:
        conn.execute("DELETE FROM files")
        conn.execute("INSERT OR REPLACE INTO meta VALUES ('parse_version', ?)", (PARSE_VERSION,))


def connect(db_path: Path, readonly: bool = False) -> sqlite3.Connection:
    db_path = Path(db_path)
    if readonly:
        conn = sqlite3.connect(readonly_uri(db_path), uri=True, timeout=30)
    else:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(db_path, timeout=30, isolation_level=None)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        _migrate(conn)
    conn.row_factory = sqlite3.Row
    return conn


def signature(adapter, path: Path) -> tuple[int, int]:
    """(sum of sizes, max mtime_ns) over a unit's member files."""
    size, mtime = 0, 0
    for member in adapter.members(path):
        try:
            st = member.stat()
        except OSError:
            continue
        size += st.st_size
        mtime = max(mtime, st.st_mtime_ns)
    return size, mtime


def _insert(conn, table: str, row_type, rows, verb: str = "INSERT") -> None:
    cols = row_type._fields
    conn.executemany(f"{verb} INTO {table} ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", rows)


def _drop_unit(conn, path: str) -> None:
    for table in OWNED_TABLES:
        conn.execute(f"DELETE FROM {table} WHERE source_path=?", (path,))
    conn.execute("DELETE FROM files WHERE path=?", (path,))


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _reconcile(conn, adapters: list, homes: dict[str, Path], log=lambda msg: None) -> None:
    """Derived state that spans units. Every statement only touches rows that differ, so reruns change nothing."""
    # Adapters that set rollup_edges = True nest sub-threads: roll every child up to its root through edges. Children that
    # lost their edge revert to themselves.
    rollup = [a.id for a in adapters if getattr(a, "rollup_edges", False)]
    if rollup:
        marks = ",".join("?" * len(rollup))
        conn.execute("DROP TABLE IF EXISTS temp.roots")
        conn.execute(
            """CREATE TEMP TABLE roots AS
               WITH RECURSIVE up(child, anc, depth) AS (
                 SELECT child_thread_id, parent_thread_id, 1 FROM edges
                 UNION ALL
                 SELECT up.child, e.parent_thread_id, up.depth + 1 FROM up JOIN edges e ON e.child_thread_id = up.anc WHERE up.depth < 64)
               SELECT child AS thread_id, anc AS root FROM up WHERE anc NOT IN (SELECT child_thread_id FROM edges)"""
        )
        conn.execute("CREATE INDEX temp.roots_thread ON roots (thread_id)")
        root_of = "COALESCE((SELECT root FROM temp.roots r WHERE r.thread_id = {t}.thread_id), {t}.thread_id)"
        for table in ("threads", "events"):
            conn.execute(
                f"UPDATE {table} SET session_id = {root_of.format(t=table)} "
                f"WHERE harness IN ({marks}) AND session_id IS NOT {root_of.format(t=table)}",
                rollup,
            )
        parent_of = "(SELECT parent_thread_id FROM edges e WHERE e.child_thread_id = threads.thread_id)"
        conn.execute(
            f"UPDATE threads SET parent_thread_id = {parent_of} WHERE harness IN ({marks}) AND parent_thread_id IS NOT {parent_of}",
            rollup,
        )
        conn.execute("DROP TABLE temp.roots")

    # Own titles first, then overlay titles (adapters without INGEST): a name the user already knows from another app's
    # sidebar wins for root threads.
    titled = [a for a in adapters if Cap.TITLES in a.capabilities and a.id in homes]
    for adapter in sorted(titled, key=lambda a: Cap.INGEST not in a.capabilities):
        try:
            raw_titles = adapter.titles(homes[adapter.id])
        except Exception as exc:  # a plugin bug must not abort ingest for every other agent
            log(f"titles failed for {adapter.id}: {exc!r}")
            continue
        for key, raw in raw_titles.items():
            title = title_from_text(raw)
            if title is None:
                continue
            if Cap.INGEST in adapter.capabilities:
                conn.execute("UPDATE threads SET title = ? WHERE thread_id = ? AND harness = ? AND title IS NOT ?", (title, key, adapter.id, title))
            else:
                harness, _, native_id = key.partition(":")
                conn.execute(
                    "UPDATE threads SET title = ? WHERE harness = ? AND thread_id = ? AND thread_id = session_id AND title IS NOT ?",
                    (title, harness, native_id, title),
                )

    untitled = conn.execute(
        """SELECT thread_id, (SELECT text FROM events e WHERE e.thread_id = threads.thread_id AND e.kind = 'prompt' ORDER BY ts LIMIT 1)
           FROM threads WHERE title IS NULL OR title = ''"""
    ).fetchall()
    for thread_id, prompt in untitled:
        title = title_from_text(prompt)
        if title is not None:
            conn.execute("UPDATE threads SET title = ? WHERE thread_id = ? AND (title IS NULL OR title = '')", (title, thread_id))


def ingest(conn: sqlite3.Connection, homes: dict | None = None, log=lambda msg: None, adapters: list | None = None, env: Env | None = None) -> dict:
    """One incremental pass. homes maps adapter id to its data dir and overrides detection (tests inject fixtures)."""
    adapters = load_adapters() if adapters is None else adapters
    homes = resolve_homes(adapters, env or Env.current(), homes)
    started = time.monotonic()
    known = {r["path"]: (r["harness"], r["size"], r["mtime_ns"]) for r in conn.execute("SELECT path, harness, size, mtime_ns FROM files")}
    scanned: set[str] = set()
    live: dict[str, str] = {}
    parsed = skipped = 0

    for adapter in adapters:
        if Cap.INGEST not in adapter.capabilities or adapter.id not in homes:
            continue
        try:
            units = list(adapter.units(homes[adapter.id]))
        except Exception as exc:
            log(f"units failed for {adapter.id}: {exc!r}")
            continue
        if homes[adapter.id].is_dir():
            scanned.add(adapter.id)  # only a readable home proves a missing file was really deleted
        for path in units:
            key = str(path)
            live[key] = adapter.id
            sig = signature(adapter, path)
            if known.get(key, (None,))[1:] == sig:
                continue
            try:
                result = adapter.parse(path)
            except Exception as exc:  # one bad file must not stop the rest; its old rows stay
                log(f"parse failed {key}: {exc!r}")
                skipped += 1
                continue
            conn.execute("BEGIN IMMEDIATE")
            try:
                _drop_unit(conn, key)
                _insert(conn, "threads", Thread, result.threads, "INSERT OR REPLACE")
                _insert(conn, "events", Event, result.events)
                _insert(conn, "edges", Edge, result.edges, "INSERT OR REPLACE")
                conn.execute("INSERT INTO files VALUES (?,?,?,?,?)", (key, adapter.id, sig[0], sig[1], _now()))
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            parsed += 1

    vanished = [p for p, (harness, *_) in known.items() if p not in live and harness in scanned]
    conn.execute("BEGIN IMMEDIATE")
    try:
        for path in vanished:
            _drop_unit(conn, path)
        _reconcile(conn, adapters, homes, log)
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise

    stats = {
        "units": len(live),
        "parsed": parsed,
        "unchanged": len(live) - parsed - skipped,
        "skipped": skipped,
        "removed": len(vanished),
        "duration_ms": round((time.monotonic() - started) * 1000),
        "finished_at": _now(),
    }
    conn.execute("INSERT OR REPLACE INTO meta VALUES ('last_ingest', ?)", (stats["finished_at"],))
    conn.execute("INSERT OR REPLACE INTO meta VALUES ('last_ingest_ms', ?)", (str(stats["duration_ms"]),))
    return stats
