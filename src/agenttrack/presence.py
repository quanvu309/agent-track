"""Presence: what the machine says each agent session is doing right now.

Each adapter with Cap.LIVE reads its own processes and transcript tails through the platform probe. An agent without LIVE,
or a platform without a probe, gets no entry; its rows keep a timestamp-derived status labelled approximate. Nothing here
touches the store, and a failing adapter is skipped, never raised.
"""

import logging
from pathlib import Path
from typing import NamedTuple

from .adapters import ENDED, IDLE, WORKING, Cap
from .platform import ProcessProbe

__all__ = ["WORKING", "IDLE", "ENDED", "Presence", "scan", "apply"]

log = logging.getLogger("agenttrack")


class Presence(NamedTuple):
    sessions: dict[str, dict]  # session_id -> {"state": working|idle|ended, "since": str|None, "pid": int|None}
    threads: dict[str, str]  # thread_id -> working|idle|ended (sub-agents, child threads)
    covered: frozenset[str]  # harnesses whose sessions missing from `sessions` are known ended


def _entry(state: str | None, since: str | None = None, pid: int | None = None) -> dict:
    return {"state": state, "since": since, "pid": pid}


def scan(adapters, homes: dict[str, Path], probe: ProcessProbe) -> Presence:
    sessions: dict[str, dict] = {}
    threads: dict[str, str] = {}
    covered: set[str] = set()
    if not probe.available:
        return Presence(sessions, threads, frozenset())
    for adapter in adapters:
        home = homes.get(adapter.id)
        if Cap.LIVE not in adapter.capabilities or home is None:
            continue
        try:
            found = adapter.live(home, probe)
        except Exception as exc:
            log.warning("live scan failed for %s: %r", adapter.id, exc)
            continue
        for s in found.sessions:
            sessions[s.session_id] = _entry(s.state, s.since, s.pid)
            threads.update(s.threads)
        if found.covered:
            covered.add(adapter.id)
    return Presence(sessions, threads, frozenset(covered))


def apply(rows: list[dict], presence: Presence) -> list[dict]:
    """Add state, state_since, pid and state_approximate to every session row, and state to each of its thread_rows.

    state_approximate is True when no live probe covers the row's harness, so its state comes from timestamps alone.
    Mutates and returns rows.
    """
    for row in rows:
        found = presence.sessions.get(row.get("session_id"))
        approximate = found is None and row.get("harness") not in presence.covered
        if found is None and row.get("harness") in presence.covered:
            found = _entry(ENDED)
        found = found or _entry(None)
        state = found["state"]
        row["state"], row["state_since"], row["pid"] = state, found["since"], found["pid"]
        row["state_approximate"] = approximate
        for thread in row.get("thread_rows") or []:
            if thread.get("thread_id") == row.get("session_id"):
                thread["state"] = state
            else:
                thread["state"] = presence.threads.get(thread.get("thread_id")) or (ENDED if state in (IDLE, ENDED) else None)
    return rows
