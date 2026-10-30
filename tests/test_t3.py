import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from agenttrack.adapters import t3


def ref(driver, native_id):
    return json.dumps({"driver": driver, "nativeThreadRef": {"driver": driver, "nativeId": native_id}})


class TitlesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)

    def build(self, threads, payloads):
        db = sqlite3.connect(self.home / "statev2.sqlite")
        db.execute("CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at TEXT)")
        db.execute("CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, provider TEXT, payload_json TEXT)")
        db.executemany("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?)", threads)
        db.executemany("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, '', ?)", payloads)
        db.commit()
        db.close()

    def test_maps_drivers_to_harnesses_and_newest_thread_wins(self):
        self.build(
            [("a", "Old", "2026-01-01"), ("b", "New", "2026-02-01"), ("c", "Codex one", "2026-01-01"), ("d", "Other", "2026-01-01")],
            [("a", ref("claudeAgent", "n1")), ("b", ref("claudeAgent", "n1")), ("c", ref("codex", "n2")), ("d", ref("antigravity", "n3"))],
        )
        self.assertEqual(t3.titles(self.home), {"claude:n1": "New", "codex:n2": "Codex one"})

    def test_bad_rows_are_skipped(self):
        self.build(
            [("a", "Fine", "1"), ("b", "Bad json", "1"), ("c", "No ref", "1")],
            [("a", ref("grok", "g1")), ("b", "{nope"), ("c", "{}")],
        )
        self.assertEqual(t3.titles(self.home), {"grok:g1": "Fine"})

    def test_missing_directory_or_unreadable_db_gives_nothing(self):
        self.assertEqual(t3.titles(self.home), {})
        (self.home / "statev2.sqlite").write_text("not a database")
        self.assertEqual(t3.titles(self.home), {})
