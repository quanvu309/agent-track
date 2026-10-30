import json
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from agenttrack import store

FIXTURES = Path(__file__).parent / "fixtures"


class IngestCase(unittest.TestCase):
    """Copies the fixture homes to a temp dir and ingests them into a throwaway store."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.homes = {}
        for harness in ("claude", "codex", "grok"):
            shutil.copytree(FIXTURES / harness, self.tmp / harness)
            self.homes[harness] = self.tmp / harness
        (self.tmp / "t3").mkdir()
        self.homes["t3"] = self.tmp / "t3"
        state = sqlite3.connect(self.tmp / "codex" / "state_5.sqlite")
        state.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL)")
        state.executemany("INSERT INTO threads VALUES (?, ?)", [("R", "Codex stored title"), ("C", "")])
        state.commit()
        state.close()
        self.conn = store.connect(self.tmp / "agenttrack.sqlite")
        self.addCleanup(self.conn.close)

    def write_t3(self, threads, links):
        """Build statev2.sqlite in the t3 home. threads: (thread_id, title, updated_at); links: (thread_id, driver, native_id)."""
        db = sqlite3.connect(self.homes["t3"] / "statev2.sqlite")
        db.execute("CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at TEXT)")
        db.execute("CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, provider TEXT, payload_json TEXT)")
        db.executemany("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?)", threads)
        db.executemany(
            "INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?)",
            [(t, d, json.dumps({"driver": d, "nativeThreadRef": {"driver": d, "nativeId": n, "strength": "strong"}})) for t, d, n in links],
        )
        db.commit()
        db.close()

    def ingest(self):
        return store.ingest(self.conn, self.homes)

    def rows(self, sql, *params):
        return [tuple(r) for r in self.conn.execute(sql, params)]

    def dump(self):
        return {
            table: sorted(self.rows(f"SELECT * FROM {table}"), key=repr)
            for table in ("threads", "events", "edges")
        } | {"files": self.rows("SELECT path, harness, size, mtime_ns FROM files ORDER BY path")}
