import unittest
from pathlib import Path

from agenttrack import adapters, presence, store
from agenttrack.adapters import Cap, base
from agenttrack.platform import Env, NullMetrics, NullProbe

from helpers import IngestCase


class FakeEntryPoint:
    def __init__(self, name, load):
        self.name, self._load = name, load

    def load(self):
        if isinstance(self._load, Exception):
            raise self._load
        return self._load


class Toy:
    id = "toy"
    display_name = "Toy"
    capabilities = frozenset({Cap.INGEST})
    process_names = ("toy",)

    def homes(self, env):
        return [env.home / ".toy"]

    def detect(self, env):
        return base.detect_home(self.id, env, self.homes(env), ())

    def units(self, home):
        return sorted(Path(home).glob("*.txt"))

    def members(self, unit):
        return [Path(unit)]

    def parse(self, unit):
        from agenttrack.model import Event, Parsed, Thread
        name = Path(unit).stem
        ts = "2026-10-10T08:00:00.000Z"
        return Parsed([Thread(name, "toy", name, None, None, None, None, ts, str(unit))],
                      [Event("toy", name, name, None, None, ts, "prompt", text="hello toy", source_path=str(unit))], [])

    def titles(self, home):
        return {}


class RegistryTest(unittest.TestCase):
    def test_builtins_load_in_a_stable_order(self):
        self.assertEqual([a.id for a in adapters.load_adapters([])], ["claude", "codex", "grok", "t3"])

    def test_t3_is_a_titles_only_overlay(self):
        t3 = next(a for a in adapters.load_adapters([]) if a.id == "t3")
        self.assertEqual(t3.capabilities, frozenset({Cap.TITLES}))

    def test_plugin_is_loaded_from_an_instance_a_class_or_a_factory(self):
        for obj in (Toy(), Toy, lambda: Toy()):
            loaded = adapters.load_adapters([FakeEntryPoint("toy", obj)])
            self.assertEqual([a.id for a in loaded][-1], "toy")

    def test_broken_plugins_warn_and_are_skipped(self):
        class Half:
            id = "half"

        points = [FakeEntryPoint("boom", RuntimeError("import failed")), FakeEntryPoint("half", Half()), FakeEntryPoint("toy", Toy())]
        with self.assertLogs("agenttrack", "WARNING") as logs:
            loaded = adapters.load_adapters(points)
        self.assertEqual([a.id for a in loaded], ["claude", "codex", "grok", "t3", "toy"])
        text = "\n".join(logs.output)
        self.assertIn("boom", text)
        self.assertIn("half", text)

    def test_duplicate_id_keeps_the_builtin(self):
        class Impostor(Toy):
            id = "claude"

        with self.assertLogs("agenttrack", "WARNING"):
            loaded = adapters.load_adapters([FakeEntryPoint("dup", Impostor())])
        self.assertEqual([a.id for a in loaded].count("claude"), 1)
        self.assertNotIsInstance(next(a for a in loaded if a.id == "claude"), Impostor)


class PluginIngestTest(IngestCase):
    def test_a_plugin_adapter_ingests_without_touching_core(self):
        toy_home = self.tmp / "toy"
        toy_home.mkdir()
        (toy_home / "a.txt").write_text("x")
        stats = store.ingest(self.conn, {**self.homes, "toy": toy_home}, adapters=[*adapters.load_adapters([]), Toy()])
        self.assertEqual(self.rows("SELECT harness, session_id FROM threads WHERE harness = 'toy'"), [("toy", "a")])
        self.assertGreater(stats["parsed"], 1)

    def test_an_adapter_without_live_gets_timestamp_status_labelled_approximate(self):
        env = Env.current()
        scan = presence.scan([Toy()], {"toy": self.tmp}, env.probe)
        self.assertEqual(scan.covered, frozenset())
        rows = presence.apply([{"session_id": "a", "harness": "toy"}], scan)
        self.assertEqual((rows[0]["state"], rows[0]["state_approximate"]), (None, True))

    def test_a_live_adapter_is_exact_and_marks_missing_sessions_ended(self):
        self.ingest()
        class NoProcesses(NullProbe):
            available = True

            def find(self, names):
                return []

        scan = presence.scan(adapters.load_adapters([]), self.homes, NoProcesses())
        self.assertIn("codex", scan.covered)
        rows = presence.apply([{"session_id": "gone", "harness": "codex"}], scan)
        self.assertEqual((rows[0]["state"], rows[0]["state_approximate"]), ("ended", False))

    def test_without_a_probe_every_row_is_approximate(self):
        scan = presence.scan(adapters.load_adapters([]), self.homes, NullProbe())
        self.assertEqual(scan, presence.Presence({}, {}, frozenset()))
        rows = presence.apply([{"session_id": "s", "harness": "claude"}], scan)
        self.assertEqual((rows[0]["state"], rows[0]["state_approximate"]), (None, True))


if __name__ == "__main__":
    unittest.main()
