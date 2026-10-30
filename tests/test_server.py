import http.client
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
from datetime import datetime
from pathlib import Path
import urllib.error
import urllib.request

from agenttrack import server

from helpers import IngestCase


class ApiTest(IngestCase):
    def setUp(self):
        super().setUp()
        self.ingestor = server.Ingestor(self.tmp / "agenttrack.sqlite", self.homes, log=lambda m: None)
        self.httpd = server.make_server("127.0.0.1", 0, self.tmp / "agenttrack.sqlite", self.ingestor)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def call(self, path, method="GET"):
        request = urllib.request.Request(self.base + path, method=method, data=b"" if method == "POST" else None)
        try:
            with urllib.request.urlopen(request) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as err:
            with err:
                return err.code, json.loads(err.read())

    def test_post_ingest_then_summary_reports_totals(self):
        status, body = self.call("/api/ingest", "POST")
        self.assertEqual((status, body["stats"]["parsed"]), (200, 8))
        status, summary = self.call("/api/summary")
        by_harness = {h["harness"]: (h["sessions"], h["input_tokens"], h["output_tokens"]) for h in summary["harnesses"]}
        self.assertEqual(by_harness, {"claude": (1, 513, 62), "codex": (1, 3600, 65), "grok": (1, 2200, 190)})
        self.assertEqual((summary["ingesting"], summary["last_ingest"] is not None), (False, True))

    def test_session_drilldown_lists_subagent_threads_models_tools_and_timeline(self):
        self.call("/api/ingest", "POST")
        status, body = self.call("/api/session/G1")
        self.assertEqual(status, 200)
        self.assertEqual([t["thread_id"] for t in body["threads"]], ["G1", "C1", "C2"])
        self.assertEqual([(m["model"], m["input_tokens"]) for m in body["models"]], [("grok-x", 2000), ("grok-y", 200)])
        self.assertEqual(sorted((t["tool"], t["calls"]) for t in body["tools"]), [("bash", 1), ("glob", 1), ("grep", 1), ("read_file", 1)])
        self.assertEqual(body["events"][0]["text"], "first grok prompt")
        self.assertEqual(body["session"]["title"], "Grok demo")

    def test_live_rows_carry_injected_presence_state_and_thread_states(self):
        from agenttrack import presence
        seen = []

        def stub(adapters, homes, probe):
            seen.append(homes)
            return presence.Presence({"G1": {"state": "working", "since": "2026-10-10T08:03:10.000Z", "pid": 4242}}, {"C1": "idle"}, frozenset({"grok"}))

        httpd = server.make_server("127.0.0.1", 0, self.tmp / "agenttrack.sqlite", self.ingestor, scan=stub)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        self.base = f"http://127.0.0.1:{httpd.server_address[1]}"
        self.call("/api/ingest", "POST")
        from datetime import timezone
        from unittest import mock
        real_live = server.queries.live  # the fixture events are old, so pin "now" next to them
        pinned = lambda conn, minutes: real_live(conn, minutes, now=datetime(2026, 10, 10, 10, 3, tzinfo=timezone.utc))
        with mock.patch.object(server.queries, "live", pinned):
            status, rows = self.call("/api/live")
        g1 = next(r for r in rows if r["session_id"] == "G1")
        self.assertEqual((status, g1["state"], g1["state_since"], g1["pid"]), (200, "working", "2026-10-10T08:03:10.000Z", 4242))
        self.assertEqual({t["thread_id"]: t["state"] for t in g1["thread_rows"]}, {"G1": "working", "C1": "idle", "C2": None})
        self.assertTrue(all("state" in r and "pid" in r for r in rows))
        self.assertEqual(seen[0], self.homes)
        _, listed = self.call("/api/sessions")
        self.assertEqual({r["session_id"]: r["state"] for r in listed if r["harness"] == "grok"}, {"G1": "working"})
        _, detail = self.call("/api/session/G1")
        self.assertEqual((detail["session"]["state"], detail["session"]["pid"]), ("working", 4242))
        self.assertNotIn("thread_rows", detail["session"])
        self.assertEqual([t["state"] for t in detail["threads"]], ["working", "idle", None])

    def test_live_rows_carry_thread_rows_and_recent_tool_calls(self):
        from agenttrack import queries
        from datetime import timezone
        self.call("/api/ingest", "POST")
        now = datetime(2026, 10, 10, 10, 3, tzinfo=timezone.utc)
        rows = queries.live(self.conn, 15, now=now)
        g1 = next(r for r in rows if r["session_id"] == "G1")
        self.assertIsInstance(g1["threads"], int)
        self.assertEqual([t["thread_id"] for t in g1["thread_rows"]], ["G1", "C1", "C2"])
        self.assertEqual(g1["recent_tool_calls"], g1["tool_calls"])
        keys = {"thread_id", "parent_thread_id", "title", "model", "started_at", "project", "input_tokens", "output_tokens",
                "tool_calls", "failed_tools", "last", "recent_events", "recent_tool_calls"}
        self.assertTrue(all(set(t) == keys for t in g1["thread_rows"]))
        self.assertEqual(sum(t["tool_calls"] for t in g1["thread_rows"]), g1["tool_calls"])
        self.assertEqual(sum(t["input_tokens"] for t in g1["thread_rows"]), g1["input_tokens"])
        self.assertEqual(queries.live(self.conn, 15, now=datetime(2026, 10, 10, 10, 20, tzinfo=timezone.utc)), [])

    def test_sessions_filter_and_tools_filter(self):
        self.call("/api/ingest", "POST")
        _, sessions = self.call("/api/sessions?harness=codex")
        self.assertEqual([(s["session_id"], s["title"], s["threads"], s["tool_calls"]) for s in sessions], [("R", "Codex stored title", 2, 2)])
        _, tools = self.call("/api/tools?harness=claude&limit=1")
        self.assertEqual(len(tools), 1)
        _, projects = self.call("/api/projects")
        self.assertEqual([(p["project"], p["sessions"], p["prompts"]) for p in projects], [("/tmp/demo", 3, 4)])
        _, grok_projects = self.call("/api/projects?harness=grok")
        self.assertEqual([(p["project"], p["sessions"], p["prompts"], p["input_tokens"]) for p in grok_projects], [("/tmp/demo", 1, 2, 2200)])

    def test_daily_counts_sessions_on_their_start_day(self):
        self.call("/api/ingest", "POST")
        _, daily = self.call("/api/daily")
        self.assertEqual(sorted((d["day"], d["harness"], d["sessions"], d["prompts"]) for d in daily),
                         [("2026-10-10", "claude", 1, 1), ("2026-10-10", "codex", 1, 1), ("2026-10-10", "grok", 1, 2)])

    def utc(self):
        self.tz("UTC")

    def tz(self, name):
        if not hasattr(time, "tzset"):
            self.skipTest("time.tzset is not available on this platform")
        previous = os.environ.get("TZ")
        os.environ["TZ"] = name
        time.tzset()

        def restore():
            os.environ.pop("TZ") if previous is None else os.environ.__setitem__("TZ", previous)
            time.tzset()

        self.addCleanup(restore)

    def test_today_buckets_a_local_day_by_hour_and_harness(self):
        self.utc()
        self.call("/api/ingest", "POST")
        status, body = self.call("/api/today?day=2026-10-10")
        self.assertEqual(status, 200)
        self.assertEqual(body["day"], "2026-10-10")
        self.assertEqual(body["rows"], [
            {"hour": 10, "harness": "claude", "sessions": 1, "prompts": 1, "tool_calls": 2, "responses": 3, "input_tokens": 513, "cached_tokens": 409, "output_tokens": 62},
            {"hour": 10, "harness": "codex", "sessions": 1, "prompts": 1, "tool_calls": 2, "responses": 4, "input_tokens": 3600, "cached_tokens": 2350, "output_tokens": 65},
            {"hour": 10, "harness": "grok", "sessions": 1, "prompts": 2, "tool_calls": 4, "responses": 4, "input_tokens": 2200, "cached_tokens": 900, "output_tokens": 190},
        ])

    def test_today_follows_the_server_time_zone(self):
        self.tz("Pacific/Kiritimati")
        self.call("/api/ingest", "POST")
        _, body = self.call("/api/today?day=2026-10-11")
        self.assertEqual([(r["hour"], r["harness"], r["tool_calls"]) for r in body["rows"]], [(0, "claude", 2), (0, "codex", 2), (0, "grok", 4)])
        self.assertEqual(self.call("/api/today?day=2026-10-10")[1]["rows"], [])

    def test_today_defaults_to_the_local_date_and_is_empty_without_events(self):
        self.utc()
        self.call("/api/ingest", "POST")
        self.assertEqual(self.call("/api/today")[1], {"day": datetime.now().date().isoformat(), "rows": []})
        self.assertEqual(self.call("/api/today?day=2026-10-11")[1], {"day": "2026-10-11", "rows": []})

    def test_today_rejects_a_malformed_day(self):
        self.assertEqual(self.call("/api/today?day=10-10")[0], 400)
        self.assertEqual(self.call("/api/today?day=today")[0], 400)

    def test_reliability_counts_known_outcomes_and_latency_per_tool(self):
        self.call("/api/ingest", "POST")
        _, body = self.call("/api/reliability")
        by_harness = {h["harness"]: (h["calls"], h["known"], h["failed"]) for h in body["harnesses"]}
        self.assertEqual(by_harness, {"claude": (2, 2, 1), "codex": (2, 1, 1), "grok": (4, 2, 1)})
        self.assertEqual([(t["harness"], t["tool"], t["failed"], t["known"]) for t in body["most_failing"]],
                         [("claude", "Read", 1, 1), ("codex", "exec", 1, 1), ("grok", "bash", 1, 1)])
        _, only = self.call("/api/reliability?harness=claude")
        self.assertEqual([h["harness"] for h in only["harnesses"]], ["claude"])

    def test_heatmap_buckets_events_by_local_weekday_and_hour(self):
        self.utc()
        self.call("/api/ingest", "POST")
        _, cells = self.call("/api/heatmap?harness=claude")
        self.assertEqual(cells, [{"weekday": 6, "hour": 10, "events": 6, "prompts": 1}])

    def test_range_limits_totals_models_and_sessions_to_local_dates(self):
        self.utc()
        self.call("/api/ingest", "POST")
        _, inside = self.call("/api/summary?since=2026-10-10&until=2026-10-10")
        self.assertEqual({h["harness"]: (h["sessions"], h["input_tokens"]) for h in inside["harnesses"]}, {"claude": (1, 513), "codex": (1, 3600), "grok": (1, 2200)})
        _, after = self.call("/api/summary?since=2026-10-11")
        self.assertEqual({h["harness"]: (h["sessions"], h["input_tokens"]) for h in after["harnesses"]}, {"claude": (0, 0), "codex": (0, 0), "grok": (0, 0)})
        self.assertEqual(self.call("/api/sessions?since=2026-10-11")[1], [])
        self.assertEqual(self.call("/api/models?until=2026-10-09")[1], [])
        self.assertEqual(self.call("/api/summary?since=10-10")[0], 400)

    def test_session_search_matches_title_project_and_prompt_text_and_reports_active_time(self):
        self.call("/api/ingest", "POST")
        ids = lambda q: sorted(s["session_id"] for s in self.call("/api/sessions?q=" + q)[1])
        self.assertEqual(ids("Demo%20title"), ["s1"])
        self.assertEqual(ids("do%20the%20thing"), ["R"])
        self.assertEqual(ids("%2Ftmp%2Fdemo"), ["G1", "R", "s1"])
        self.assertEqual(ids("100%25"), [])
        _, rows = self.call("/api/sessions?harness=claude")
        self.assertEqual((rows[0]["first"], rows[0]["last"], rows[0]["failed_tools"], rows[0]["active_s"]), ("2026-10-10T10:00:00.000Z", "2026-10-10T10:00:05.000Z", 1, 5))

    def test_live_lists_sessions_with_events_inside_the_window(self):
        self.call("/api/ingest", "POST")
        self.assertEqual(self.call("/api/live")[1], [])
        from agenttrack import queries
        from datetime import datetime, timezone
        rows = queries.live(self.conn, 15, datetime(2026, 10, 10, 10, 3, tzinfo=timezone.utc))
        self.assertEqual([(r["session_id"], r["recent_events"]) for r in rows], [("G1", 10), ("R", 7), ("s1", 6)])
        self.assertEqual(queries.live(self.conn, 15, datetime(2026, 10, 10, 10, 20, tzinfo=timezone.utc)), [])

    def burn_rows(self, **kwargs):
        from agenttrack import queries
        from datetime import timezone
        return queries.burn(self.conn, now=datetime(2026, 10, 10, 10, 7, 30, tzinfo=timezone.utc), **kwargs)

    def test_burn_buckets_tokens_by_utc_bucket_and_harness_in_any_time_zone(self):
        self.call("/api/ingest", "POST")
        self.conn.executemany(
            "INSERT INTO events (harness, session_id, thread_id, ts, kind, input_tokens, cached_tokens, output_tokens, source_path) VALUES ('claude','s1','s1',?,'response',?,?,?,'x')",
            [("2026-10-10T10:04:59.999Z", 1000, 100, 10), ("2026-10-10T10:05:00.000Z", 2000, 200, 20)],
        )
        for zone in ("UTC", "Pacific/Kiritimati", "America/St_Johns"):
            self.tz(zone)
            body = self.burn_rows(minutes=10, bucket=5)
            self.assertEqual((body["bucket_minutes"], body["since"], body["until"]), (5, "2026-10-10T09:55:00.000Z", "2026-10-10T10:07:30.000Z"))
            self.assertEqual(body["rows"], [
                {"ts": "2026-10-10T10:00:00.000Z", "harness": "claude", "input_tokens": 1513, "cached_tokens": 509, "output_tokens": 72, "prompts": 1, "tool_calls": 2, "responses": 4},
                {"ts": "2026-10-10T10:00:00.000Z", "harness": "codex", "input_tokens": 3600, "cached_tokens": 2350, "output_tokens": 65, "prompts": 1, "tool_calls": 2, "responses": 4},
                {"ts": "2026-10-10T10:00:00.000Z", "harness": "grok", "input_tokens": 2200, "cached_tokens": 900, "output_tokens": 190, "prompts": 2, "tool_calls": 4, "responses": 4},
                {"ts": "2026-10-10T10:05:00.000Z", "harness": "claude", "input_tokens": 2000, "cached_tokens": 200, "output_tokens": 20, "prompts": 0, "tool_calls": 0, "responses": 1},
            ])
        self.assertEqual([(r["ts"], r["output_tokens"]) for r in self.burn_rows(minutes=60, bucket=60, harness="claude")["rows"]],
                         [("2026-10-10T10:00:00.000Z", 92)])
        self.assertEqual([(r["ts"], r["output_tokens"]) for r in self.burn_rows(minutes=2, bucket=1)["rows"]], [("2026-10-10T10:05:00.000Z", 20)])
        self.assertEqual(self.burn_rows(minutes=1, bucket=1)["rows"], [])

    def test_burn_endpoint_validates_and_defaults(self):
        status, body = self.call("/api/burn")
        self.assertEqual((status, body["bucket_minutes"], body["rows"]), (200, 5, []))
        self.assertEqual(self.call("/api/burn?bucket=7")[0], 400)
        self.assertEqual(self.call("/api/burn?bucket=x")[0], 400)
        self.assertEqual(self.call("/api/burn?minutes=x")[0], 400)
        self.assertEqual(self.call("/api/burn?harness=bogus")[0], 400)
        self.assertEqual(self.call("/api/burn?bucket=60&minutes=99999&harness=grok")[0], 200)

    def test_errors(self):
        self.assertEqual(self.call("/api/session/nope")[0], 404)
        self.assertEqual(self.call("/api/tools?harness=bogus")[0], 400)
        self.assertEqual(self.call("/api/tools?limit=x")[0], 400)
        self.assertEqual(self.call("/api/summary", "POST")[0], 404)

    def test_index_is_served(self):
        with urllib.request.urlopen(self.base + "/") as resp:
            self.assertIn(b"<title>", resp.read())

    def raw(self, method, path, headers):
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1])
        self.addCleanup(conn.close)
        conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        for name, value in headers.items():
            conn.putheader(name, value)
        conn.endheaders()
        resp = conn.getresponse()
        resp.read()
        return resp.status

    def test_a_foreign_host_header_is_refused_like_the_curl_rebinding_probe(self):
        port = self.httpd.server_address[1]
        for host in (f"attacker.example:{port}", "attacker.example", f"127.0.0.1.evil.test:{port}", "127.0.0.1:1", ""):
            with self.subTest(host=host):
                self.assertEqual(self.raw("GET", "/api/sessions", {"Host": host}), 403)

    def test_loopback_host_names_are_accepted(self):
        port = self.httpd.server_address[1]
        for host in (f"127.0.0.1:{port}", f"localhost:{port}", f"LOCALHOST:{port}"):
            with self.subTest(host=host):
                self.assertEqual(self.raw("GET", "/api/summary", {"Host": host}), 200)

    def test_cross_origin_post_is_refused_and_same_origin_or_no_origin_passes(self):
        host = f"127.0.0.1:{self.httpd.server_address[1]}"
        self.assertEqual(self.raw("POST", "/api/ingest", {"Host": host, "Origin": "https://evil.example", "Content-Length": "0"}), 403)
        self.assertEqual(self.raw("POST", "/api/ingest", {"Host": host, "Origin": f"http://{host}", "Content-Length": "0"}), 200)
        self.assertEqual(self.raw("POST", "/api/ingest", {"Host": host, "Content-Length": "0"}), 200)

    def test_allow_remote_disables_the_host_check(self):
        db = self.tmp / "remote.sqlite"
        httpd = server.make_server("127.0.0.1", 0, db, server.Ingestor(db, {}, log=lambda m: None), allow_remote=True)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1])
        self.addCleanup(conn.close)
        conn.request("GET", "/api/summary", headers={"Host": "dash.example.net"})
        self.assertEqual(conn.getresponse().status, 200)



class StaticAssetTest(unittest.TestCase):
    """Serves a throwaway static dir, so it does not depend on the committed frontend build."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        static = self.tmp / "static"
        (static / "assets").mkdir(parents=True)
        (static / "index.html").write_text("<!doctype html><title>t</title>")
        (static / "secret.js").write_text("outside assets")
        (static / "assets" / "index-Ab12_c.js").write_text("console.log(1)")
        (static / "assets" / "index-Ab12_c.css").write_text("body{}")
        (static / "assets" / "inter-latin-wght.woff2").write_bytes(b"wOF2")
        (static / "assets" / "favicon-32-Ab12.png").write_bytes(b"\x89PNG")
        (static / "assets" / "notes.txt").write_text("no type")
        db = self.tmp / "agenttrack.sqlite"
        self.httpd = server.make_server("127.0.0.1", 0, db, server.Ingestor(db, {}, log=lambda m: None), static)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)

    def get(self, raw_path):
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1])
        self.addCleanup(conn.close)
        conn.putrequest("GET", raw_path, skip_accept_encoding=True)
        conn.endheaders()
        resp = conn.getresponse()
        return resp.status, dict(resp.getheaders()), resp.read()

    def test_assets_are_served_with_their_type_and_cached_for_good(self):
        status, headers, body = self.get("/assets/index-Ab12_c.js")
        self.assertEqual((status, body), (200, b"console.log(1)"))
        self.assertEqual(headers["Content-Type"], "text/javascript; charset=utf-8")
        self.assertEqual(headers["Cache-Control"], "public, max-age=31536000, immutable")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(self.get("/assets/index-Ab12_c.css")[1]["Content-Type"], "text/css; charset=utf-8")
        self.assertEqual(self.get("/assets/inter-latin-wght.woff2")[1]["Content-Type"], "font/woff2")
        self.assertEqual(self.get("/assets/favicon-32-Ab12.png")[1]["Content-Type"], "image/png")

    def test_missing_ui_gets_a_clear_message(self):
        (self.tmp / "static" / "index.html").unlink()
        status, _, body = self.get("/")
        self.assertEqual(status, 503)
        self.assertIn(b"pnpm build", body)

    def test_index_is_not_cached(self):
        status, headers, body = self.get("/")
        self.assertEqual((status, headers["Cache-Control"], headers["Content-Type"]), (200, "no-store", "text/html; charset=utf-8"))

    def test_traversal_attempts_are_not_found(self):
        for path in ("/assets/../secret.js", "/assets/..%2fsecret.js", "/assets/%2e%2e%2fsecret.js", "/assets/%2E%2E/secret.js",
                     "/assets/..\\secret.js", "/assets/..%5csecret.js", "/assets//etc/passwd", "/assets/%2fetc%2fpasswd",
                     "/assets/./index-Ab12_c.js", "/assets/sub/index-Ab12_c.js", "/assets/"):
            with self.subTest(path=path):
                status, _, body = self.get(path)
                self.assertEqual(status, 404)
                self.assertNotIn(b"outside assets", body)

    def test_unknown_files_and_types_are_not_found(self):
        self.assertEqual(self.get("/assets/missing-123.js")[0], 404)
        self.assertEqual(self.get("/assets/notes.txt")[0], 404)
        self.assertEqual(self.get("/secret.js")[0], 404)


if __name__ == "__main__":
    unittest.main()
