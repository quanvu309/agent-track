import json
import os
import shutil
import sqlite3
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from agenttrack import server, store
from agenttrack.adapters import load_adapters
from agenttrack.machine import Sampler
from agenttrack.platform import LinuxMetrics, LinuxProc, parse_status
from agenttrack.model import norm_ts

ME, SOMEONE_ELSE = 1000, 999
OTHER_USERS = {105, 106}
SECRET = "--api-key=sk-SECRET-123"
KB = 1024
MEMINFO = "MemTotal:        8000000 kB\nMemFree:          500000 kB\nMemAvailable:    3000000 kB\nSwapTotal:       1000000 kB\nSwapFree:         750000 kB\nHugePages_Total:       0\n"


def write_proc(root: Path, stat="cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 50 0 50 350 50 0 0 0 0 0\ncpu1 50 0 50 350 50 0 0 0 0 0\n", meminfo=MEMINFO):
    root.mkdir(parents=True, exist_ok=True)
    (root / "meminfo").write_text(meminfo)
    (root / "stat").write_text(stat)
    (root / "loadavg").write_text("1.50 1.00 0.50 2/300 4242\n")
    (root / "uptime").write_text("3600.55 7000.00\n")
    # (pid, name, uid, (RssAnon, RssFile, RssShmem) in kB, cwd). Every user process maps the same 1.6 GB of shared
    # libraries, and chrome adds 1 GB of shared memory, so their VmRSS values sum to more than MemTotal.
    processes = [
        (101, "claude", ME, (400000, 1600000, 0), "/home/u/projects/acme"),
        (102, "codex", ME, (200000, 1600000, 0), "/home/u/projects/acme"),
        (103, "codex-code-mode", ME, (10000, 1600000, 0), "/home/u/projects/acme"),
        (104, "node", ME, (300000, 1600000, 0), None),
        (105, "postgres", SOMEONE_ELSE, (900000, 100000, 0), "/var/lib/postgresql"),
        (106, "kthreadd", 0, None, "/"),
        (107, "chrome", ME, (100000, 0, 1000000), "/proc/42/fdinfo"),
    ]
    for pid, comm, uid, kb, cwd in processes:
        d = root / str(pid)
        d.mkdir(exist_ok=True)
        (d / "cmdline").write_text(f"{comm}\0{SECRET}\0")
        mem_lines = ""
        if kb:
            anon, file, shmem = kb
            mem_lines = f"VmRSS:\t{anon + file + shmem:>8} kB\nRssAnon:\t{anon:>8} kB\nRssFile:\t{file:>8} kB\nRssShmem:\t{shmem:>8} kB\n"
        (d / "status").write_text(f"Name:\t{comm}\nPPid:\t1\nUid:\t{uid}\t{uid}\t{uid}\t{uid}\n{mem_lines}Threads:\t1\n")
        if cwd and not (d / "cwd").is_symlink():
            (d / "cwd").symlink_to(cwd)


class SamplerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.proc = self.tmp / "proc"
        self.db = self.tmp / "agenttrack.sqlite"
        self.t = 1791626400.0  # 2026-10-10T10:00:00Z
        self.logs = []

    def sampler(self, proc=None):
        root = proc or self.proc
        return Sampler(self.db, LinuxProc(root, visible=lambda pid: pid not in OTHER_USERS), LinuxMetrics(root), load_adapters(), clock=lambda: self.t, log=self.logs.append)

    def rows(self, sql):
        conn = sqlite3.connect(self.db)
        self.addCleanup(conn.close)
        return [tuple(r) for r in conn.execute(sql)]

    def test_two_samples_give_memory_cpu_agents_and_top_processes(self):
        write_proc(self.proc)
        sampler = self.sampler()
        first = sampler.tick()
        self.assertIsNone(first["cpu_pct"])
        write_proc(self.proc, stat="cpu  250 0 250 750 150 0 0 0 0 0\ncpu0 1 0 0 0 0 0 0 0 0 0\ncpu1 1 0 0 0 0 0 0 0 0 0\n")
        self.t += 15
        now = sampler.tick()
        disk = shutil.disk_usage(self.tmp)
        self.assertLess(abs(now["disk_used"] - disk.used), 64 * 2**20)
        self.assertEqual({k: v for k, v in now.items() if k not in ("agents", "top", "disk_used")}, {
            "ts": "2026-10-10T10:00:15.000Z", "mem_total": 8000000 * KB, "mem_used": 5000000 * KB, "mem_available": 3000000 * KB,
            "swap_total": 1000000 * KB, "swap_used": 250000 * KB, "cpu_pct": 75.0, "load": [1.5, 1.0, 0.5], "cpus": 2, "uptime_s": 3600,
            "disk_total": disk.total, "procs": 7,
        })
        self.assertEqual(now["agents"], [
            {"harness": "claude", "mem": 400000 * KB, "procs": 1},
            {"harness": "codex", "mem": 210000 * KB, "procs": 2},
            {"harness": "grok", "mem": 0, "procs": 0},
            {"harness": "other", "mem": 400000 * KB, "procs": 2},
        ])
        self.assertEqual(now["top"], [
            {"pid": 101, "comm": "claude", "harness": "claude", "project": "projects/acme", "mem": 400000 * KB},
            {"pid": 104, "comm": "node", "harness": None, "project": None, "mem": 300000 * KB},
            {"pid": 102, "comm": "codex", "harness": "codex", "project": "projects/acme", "mem": 200000 * KB},
            {"pid": 107, "comm": "chrome", "harness": None, "project": None, "mem": 100000 * KB},
            {"pid": 103, "comm": "codex-code-mode", "harness": "codex", "project": "projects/acme", "mem": 10000 * KB},
        ])
        self.assertEqual(sampler.latest, now)
        self.assertEqual(self.rows("SELECT ts, mem_used, cpu_pct, load1, procs FROM machine_samples ORDER BY ts"),
                         [("2026-10-10T10:00:00.000Z", 5000000 * KB, None, 1.5, 7), ("2026-10-10T10:00:15.000Z", 5000000 * KB, 75.0, 1.5, 7)])
        self.assertEqual(self.rows("SELECT harness, mem, procs FROM machine_agent WHERE ts = '2026-10-10T10:00:15.000Z' ORDER BY harness"),
                         [("claude", 400000 * KB, 1), ("codex", 210000 * KB, 2), ("grok", 0, 0), ("other", 400000 * KB, 2)])
        self.assertEqual(self.logs, [])

    def test_per_process_memory_is_private_and_sums_below_ram_where_vmrss_does_not(self):
        write_proc(self.proc)
        now = self.sampler().tick()
        vmrss = sum(int(line.split()[1]) * KB for pid in (101, 102, 103, 104, 107)
                    for line in (self.proc / str(pid) / "status").read_text().splitlines() if line.startswith("VmRSS:"))
        mem = sum(a["mem"] for a in now["agents"])
        self.assertEqual((vmrss, mem, now["mem_total"]), (8410000 * KB, 1010000 * KB, 8000000 * KB))

    def test_command_lines_and_other_users_never_reach_the_output(self):
        write_proc(self.proc)
        now = self.sampler().tick()
        dumped = json.dumps(now) + repr(self.rows("SELECT * FROM machine_samples")) + repr(self.rows("SELECT * FROM machine_agent"))
        self.assertNotIn("SECRET", dumped)
        self.assertNotIn("postgres", dumped)
        self.assertNotIn(105, [p["pid"] for p in now["top"]])
        self.assertIn("claude", dumped)

    @unittest.skipUnless(hasattr(os, "getuid"), "ownership filter uses os.getuid")
    def test_by_default_only_processes_owned_by_this_user_are_visible(self):
        write_proc(self.proc)
        now = Sampler(self.db, LinuxProc(self.proc), LinuxMetrics(self.proc), load_adapters(), clock=lambda: self.t, log=self.logs.append).tick()
        self.assertEqual(sorted(p["pid"] for p in now["top"]), [101, 102, 103, 104, 105, 106, 107])
        real = Sampler(self.db, LinuxProc(), LinuxMetrics(), load_adapters(), log=self.logs.append).sample()
        self.assertEqual({p["pid"] for p in real["top"]} & {1}, set())

    def test_a_missing_meminfo_field_or_proc_degrades_to_null(self):
        write_proc(self.proc, meminfo="MemTotal:        8000000 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n")
        now = self.sampler().tick()
        self.assertEqual((now["mem_total"], now["mem_used"], now["mem_available"], now["swap_used"]), (8000000 * KB, None, None, 0))
        self.t += 15
        nothing = self.sampler(self.tmp / "no-proc").tick()
        self.assertEqual((nothing["mem_total"], nothing["cpu_pct"], nothing["load"], nothing["cpus"], nothing["procs"], nothing["top"]),
                         (None, None, None, None, None, []))
        self.assertEqual([a["mem"] for a in nothing["agents"]], [0, 0, 0, 0])
        self.assertEqual(len(self.rows("SELECT * FROM machine_samples")), 2)

    def test_samples_older_than_seven_days_are_pruned(self):
        write_proc(self.proc)
        sampler = self.sampler()
        sampler.tick()
        self.t += 7 * 86400
        sampler.tick()
        self.assertEqual(len(self.rows("SELECT * FROM machine_samples")), 2)
        self.t += 1
        sampler.tick()
        self.assertEqual(self.rows("SELECT ts FROM machine_samples ORDER BY ts"), [("2026-10-17T10:00:00.000Z",), ("2026-10-17T10:00:01.000Z",)])
        self.assertEqual(self.rows("SELECT DISTINCT ts FROM machine_agent ORDER BY ts"), [("2026-10-17T10:00:00.000Z",), ("2026-10-17T10:00:01.000Z",)])

    def test_existing_db_without_machine_tables_is_migrated_and_keeps_its_data(self):
        conn = store.connect(self.db)
        conn.execute("DROP TABLE machine_samples")
        conn.execute("DROP TABLE machine_agent")
        conn.execute("INSERT INTO events (harness, session_id, thread_id, ts, kind, source_path) VALUES ('claude','s','s','2026-10-10T10:00:00.000Z','prompt','f')")
        conn.close()
        write_proc(self.proc)
        self.sampler().tick()
        self.assertEqual(self.rows("SELECT count(*) FROM events"), [(1,)])
        self.assertEqual(self.rows("SELECT ts, procs FROM machine_samples"), [("2026-10-10T10:00:00.000Z", 7)])
        self.assertEqual(self.logs, [])

    def test_machine_agent_column_rss_is_renamed_to_mem_once_and_keeps_its_value(self):
        conn = sqlite3.connect(self.db)
        conn.execute("CREATE TABLE machine_agent (ts TEXT NOT NULL, harness TEXT NOT NULL, rss INT NOT NULL, procs INT NOT NULL, PRIMARY KEY (ts, harness)) WITHOUT ROWID")
        conn.execute("INSERT INTO machine_agent VALUES ('2026-10-10T10:00:00.000Z', 'claude', 1234, 2)")
        conn.commit()
        conn.close()
        for _ in range(2):
            store.connect(self.db).close()
            self.assertEqual([r[1] for r in self.rows("PRAGMA table_info(machine_agent)")], ["ts", "harness", "mem", "procs"])
            self.assertEqual(self.rows("SELECT harness, mem, procs FROM machine_agent"), [("claude", 1234, 2)])


class ParseStatusTest(unittest.TestCase):
    def test_rssanon_is_the_private_memory(self):
        text = "Name:\tchrome\nVmRSS:\t  900 kB\nRssAnon:\t  500 kB\nRssFile:\t  300 kB\nRssShmem:\t  100 kB\nThreads:\t1\n"
        self.assertEqual(parse_status(text), ("chrome", 500 * KB))

    def test_without_rssanon_vmrss_minus_file_and_shared_memory(self):
        text = "Name:\tnode\nVmRSS:\t  900 kB\nRssFile:\t  300 kB\nRssShmem:\t  100 kB\n"
        self.assertEqual(parse_status(text), ("node", 500 * KB))

    def test_with_only_vmrss_that_is_the_memory(self):
        self.assertEqual(parse_status("Name:\tnode\nVmRSS:\t  900 kB\nThreads:\t1\n"), ("node", 900 * KB))

    def test_a_kernel_thread_has_no_memory_lines(self):
        self.assertEqual(parse_status("Name:\tkthreadd\nThreads:\t1\n"), ("kthreadd", 0))


class MachineApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        write_proc(self.tmp / "proc")
        db = self.tmp / "agenttrack.sqlite"
        self.t = float(int(time.time()) // 60 * 60 - 60)
        proc = self.tmp / "proc"
        self.sampler = Sampler(db, LinuxProc(proc, visible=lambda pid: pid not in OTHER_USERS), LinuxMetrics(proc), load_adapters(), clock=lambda: self.t, log=lambda m: None)
        ingestor = server.Ingestor(db, {}, log=lambda m: None)
        self.httpd = server.make_server("127.0.0.1", 0, db, ingestor, sampler=self.sampler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def call(self, path):
        try:
            with urllib.request.urlopen(self.base + path) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as err:
            with err:
                return err.code, json.loads(err.read())

    def test_now_is_null_before_the_first_sample(self):
        self.assertEqual(self.call("/api/machine"), (200, {"available": True, "now": None, "bucket_seconds": 15, "series": []}))

    def test_series_averages_samples_into_buckets(self):
        start = self.t
        for offset, stat_user in ((0, 100), (5, 200), (20, 300)):
            self.t = start + offset
            write_proc(self.tmp / "proc", stat=f"cpu  {stat_user} 0 0 100 0 0 0 0 0 0\n")
            self.sampler.tick()
        status, body = self.call("/api/machine?minutes=60")
        self.assertEqual(status, 200)
        self.assertEqual(body["now"]["ts"], self.sampler.latest["ts"])
        self.assertEqual(body["bucket_seconds"], 15)
        claude, codex, other = 400000 * KB, 210000 * KB, 400000 * KB
        agents = {"claude": claude, "codex": codex, "grok": 0, "other": other}
        self.assertEqual(body["series"], [
            {"ts": norm_ts(start), "mem_used": 5000000 * KB, "swap_used": 250000 * KB, "cpu_pct": 100.0, "load1": 1.5, "agents": agents},
            {"ts": norm_ts(start + 15), "mem_used": 5000000 * KB, "swap_used": 250000 * KB, "cpu_pct": 100.0, "load1": 1.5, "agents": agents},
        ])
        _, week = self.call("/api/machine?minutes=10080")
        self.assertEqual((week["bucket_seconds"], {p["mem_used"] for p in week["series"]}), (2016, {5000000 * KB}))
        self.assertEqual(self.call("/api/machine?minutes=abc")[0], 400)


if __name__ == "__main__":
    unittest.main()
