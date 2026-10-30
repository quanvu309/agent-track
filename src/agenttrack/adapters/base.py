"""The contract between agent-track and one coding agent. One adapter module per agent."""

from enum import Enum
from pathlib import Path
from typing import Iterable, NamedTuple, Protocol

from ..model import Parsed
from ..platform import Env, ProcessProbe

WORKING, IDLE, ENDED = "working", "idle", "ended"

Unit = Path


class Cap(Enum):
    INGEST = "ingest"
    TITLES = "titles"
    SUBAGENTS = "subagents"
    TOKENS = "tokens"
    LIVE = "live"


class Detection(NamedTuple):
    adapter_id: str
    home: Path | None
    schema_ok: bool
    note: str | None


class LiveSession(NamedTuple):
    session_id: str
    state: str  # working | idle | ended
    since: str | None
    pid: int | None
    threads: dict[str, str] = {}  # thread_id -> working | idle | ended, for sub-agents and child threads


class LiveScan(NamedTuple):
    sessions: list[LiveSession]
    covered: bool  # True when a session missing from `sessions` is known to have ended


class Adapter(Protocol):
    id: str
    display_name: str
    capabilities: frozenset[Cap]
    process_names: tuple[str, ...]
    rollup_edges: bool  # optional, default False. True when parse() emits Edge rows for nested sub-threads that count toward their root session

    def homes(self, env: Env) -> list[Path]: ...

    def detect(self, env: Env) -> Detection: ...

    def units(self, home: Path) -> Iterable[Unit]: ...

    def members(self, unit: Unit) -> list[Path]: ...

    def parse(self, unit: Unit) -> Parsed: ...

    def titles(self, home: Path) -> dict[str, str]:
        """Own threads: thread_id -> stored title. An adapter without Cap.INGEST is a titles-only overlay and keys
        "<harness>:<native thread id>" instead; those titles apply to root threads of that harness and win."""

    def live(self, home: Path, probe: ProcessProbe) -> LiveScan: ...


def candidate_homes(adapter_id: str, env: Env, *defaults: Path) -> list[Path]:
    override = env.home_overrides.get(adapter_id)
    return [Path(override)] if override else list(defaults)


def detect_home(adapter_id: str, env: Env, candidates: list[Path], markers: tuple[str, ...]) -> Detection:
    """schema_ok means every marker path exists under the first candidate home that exists."""
    home = next((c for c in candidates if c.is_dir()), None)
    if home is None:
        return Detection(adapter_id, None, False, "no data directory found")
    missing = [m for m in markers if not (home / m).exists()]
    return Detection(adapter_id, home, not missing, f"missing {', '.join(missing)}" if missing else None)
