"""T3 Code thread titles, a titles-only overlay (no INGEST): T3 Code launches Claude, Codex and Grok sessions and
keeps its own title for each in ~/.t3/userdata/statev2.sqlite, which is the name the user sees in the T3 sidebar."""

import json
import sqlite3
from pathlib import Path

from ..platform import Env, readonly_uri
from .base import Cap, candidate_homes, detect_home

HARNESS = "t3"
DRIVERS = {"claudeAgent": "claude", "codex": "codex", "grok": "grok"}

_QUERY = """SELECT p.payload_json, t.title, t.updated_at
            FROM orchestration_v2_projection_provider_threads p
            JOIN orchestration_v2_projection_threads t ON t.thread_id = p.thread_id
            WHERE t.title IS NOT NULL AND t.title <> ''"""


def titles(home: Path) -> dict[str, str]:
    """"<harness>:<native session id>" -> T3 thread title. Empty when the db is missing, locked or unreadable.

    A native id seen under several T3 threads keeps the title of the most recently updated one.
    """
    db = Path(home) / "statev2.sqlite"
    if not db.is_file():
        return {}
    try:
        conn = sqlite3.connect(readonly_uri(db), uri=True, timeout=2)
        try:
            rows = conn.execute(_QUERY).fetchall()
        finally:
            conn.close()
    except sqlite3.Error:
        return {}
    found: dict[tuple[str, str], tuple[str, str]] = {}
    for payload, title, updated_at in rows:
        try:
            ref = json.loads(payload)["nativeThreadRef"]
            harness, native_id = DRIVERS.get(ref["driver"]), ref["nativeId"]
        except (TypeError, ValueError, KeyError):
            continue
        if harness is None or not isinstance(native_id, str) or not native_id:
            continue
        key = (harness, native_id)
        if key not in found or str(updated_at or "") > found[key][0]:
            found[key] = (str(updated_at or ""), title)
    return {f"{harness}:{native_id}": title for (harness, native_id), (_, title) in found.items()}


class T3Adapter:
    id = HARNESS
    display_name = "T3 Code"
    capabilities = frozenset({Cap.TITLES})
    process_names: tuple[str, ...] = ()

    def homes(self, env: Env) -> list[Path]:
        return candidate_homes(self.id, env, env.home / ".t3" / "userdata")

    def detect(self, env: Env):
        return detect_home(self.id, env, self.homes(env), ("statev2.sqlite",))

    def units(self, home: Path):
        return ()

    def members(self, unit: Path) -> list[Path]:
        return []

    def parse(self, unit: Path):
        raise NotImplementedError("T3 is a titles-only overlay")

    def titles(self, home: Path) -> dict[str, str]:
        return titles(home)


ADAPTER = T3Adapter()
