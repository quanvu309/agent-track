"""A deliberately wrong adapter for `adapter check` tests."""

from pathlib import Path

from agenttrack.adapters import Cap, candidate_homes, detect_home
from agenttrack.model import Event, Parsed, Thread


class BrokenAdapter:
    id = "toy"
    display_name = "Toy"
    capabilities = frozenset({Cap.INGEST, Cap.TOKENS, Cap.TITLES})  # TITLES declared, titles() missing
    process_names = ("toy",)

    def homes(self, env):
        return candidate_homes(self.id, env, env.home / ".toy")

    def detect(self, env):
        return detect_home(self.id, env, self.homes(env), ())

    def units(self, home: Path):
        return sorted(Path(home).glob("*.txt"))

    def members(self, unit):
        return [unit]

    def parse(self, unit):
        thread = Thread("t1", "toy", "t1", None, None, None, None, None, str(unit))
        event = Event("toy", "t1", "t1", None, None, "yesterday", "response", source_path=str(unit))
        return Parsed([thread], [event], [])


ADAPTER = BrokenAdapter()
