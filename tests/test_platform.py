import io
import json
import os
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from agenttrack import cli, config
from agenttrack.adapters import load_adapters
from agenttrack.platform import Env, LinuxMetrics, LinuxProc, NullMetrics, NullProbe, PsutilMetrics, PsutilProbe


def fake_env(os_name, home, environ=None, probe=None, metrics=None):
    home = Path(home)
    return Env(
        os=os_name, home=home, xdg_data=home / ".local" / "share", xdg_config=home / ".config",
        app_support=home / "Library" / "Application Support", appdata=home / "AppData" / "Roaming",
        probe=probe or NullProbe(), metrics=metrics or NullMetrics(), environ=environ or {},
    )


class EnvPathsTest(unittest.TestCase):
    def test_default_db_and_config_follow_each_operating_system(self):
        home = Path("/u/me")
        cases = {
            "linux": (home / ".local/share/agent-track/agent-track.sqlite", home / ".config/agent-track/config.toml"),
            "darwin": (home / "Library/Application Support/agent-track/agent-track.sqlite", home / "Library/Application Support/agent-track/config.toml"),
            "windows": (home / "AppData/Roaming/agent-track/agent-track.sqlite", home / "AppData/Roaming/agent-track/config.toml"),
        }
        for name, (db, cfg) in cases.items():
            env = fake_env(name, home)
            self.assertEqual((env.default_db, env.config_path), (db, cfg), name)

    def test_current_honours_xdg_and_appdata_variables(self):
        linux = Env.current({"XDG_DATA_HOME": "/x/data", "XDG_CONFIG_HOME": "/x/cfg"}, "linux", Path("/u"))
        self.assertEqual((linux.default_db.parent, linux.config_dir), (Path("/x/data/agent-track"), Path("/x/cfg/agent-track")))
        windows = Env.current({"APPDATA": "C:/Roaming"}, "win32", Path("/u"))
        self.assertEqual((windows.os, windows.config_dir), ("windows", Path("C:/Roaming/agent-track")))
        self.assertEqual(Env.current({}, "darwin", Path("/u")).os, "darwin")

    def test_adapters_resolve_their_homes_from_the_env_on_every_os(self):
        for name in ("linux", "darwin", "windows"):
            env = fake_env(name, "/u/me")
            homes = {a.id: a.homes(env)[0] for a in load_adapters([])}
            self.assertEqual(homes, {"claude": Path("/u/me/.claude"), "codex": Path("/u/me/.codex"), "grok": Path("/u/me/.grok"),
                                     "t3": Path("/u/me/.t3/userdata")}, name)

    def test_a_home_override_replaces_the_default(self):
        env = fake_env("linux", "/u/me").with_overrides({"claude": Path("/elsewhere")})
        claude = next(a for a in load_adapters([]) if a.id == "claude")
        self.assertEqual(claude.homes(env), [Path("/elsewhere")])

    def test_without_psutil_or_proc_the_probe_is_null(self):
        with mock.patch.dict(sys.modules, {"psutil": None}):
            env = Env.current({}, "darwin", Path("/u"))
        self.assertEqual((env.probe.name, env.metrics.name, env.probe.available), ("NullProbe", "NullMetrics", False))
        self.assertEqual(env.metrics.read()["mem_total"], None)

    def test_psutil_is_used_off_linux_when_installed(self):
        with mock.patch.dict(sys.modules, {"psutil": fake_psutil()}):
            env = Env.current({}, "windows", Path("/u"))
        self.assertEqual((env.probe.name, env.metrics.name), ("PsutilProbe", "PsutilMetrics"))

    @unittest.skipUnless(sys.platform.startswith("linux") and os.path.isdir("/proc/self"), "needs a real /proc")
    def test_linux_uses_stdlib_proc(self):
        env = Env.current({}, "linux", Path("/u"))
        self.assertIsInstance(env.probe, LinuxProc)
        self.assertIsInstance(env.metrics, LinuxMetrics)


def fake_psutil():
    class P:
        def __init__(self, pid, name, user="me"):
            self.pid, self.info = pid, {"pid": pid, "name": name, "username": user}

        def memory_full_info(self):
            return types.SimpleNamespace(uss=2048, rss=9999)

        def create_time(self):
            return 1700000000.4

        def open_files(self):
            return [types.SimpleNamespace(path="/r/rollout-x.jsonl")]

        def cwd(self):
            return "/w/proj"

        def username(self):
            return "me"

    table = {1: P(1, "claude.exe"), 2: P(2, "codex-code-mode"), 3: P(3, "svchost", "SYSTEM")}
    ps = types.SimpleNamespace()
    ps.Process = lambda pid=1: table[pid if pid in table else 1]
    ps.process_iter = lambda attrs=None: iter(table.values())
    ps.virtual_memory = lambda: types.SimpleNamespace(total=100, available=40)
    ps.swap_memory = lambda: types.SimpleNamespace(total=10, used=1)
    ps.cpu_percent = lambda interval=None: 12.34
    ps.cpu_count = lambda: 8
    ps.boot_time = lambda: 0.0
    return ps


class PsutilTest(unittest.TestCase):
    def test_probe_and_metrics_map_psutil_results(self):
        ps = fake_psutil()
        probe, metrics = PsutilProbe(ps), PsutilMetrics(ps)
        total, mine = probe.processes()
        self.assertEqual((total, [(p.pid, p.name, p.mem) for p in mine]), (3, [(1, "claude", 2048), (2, "codex-code-mode", 2048)]))
        self.assertEqual(probe.find(("claude",)), [1])
        self.assertEqual(probe.find(("codex",)), [2])
        self.assertEqual((probe.start_time(1), probe.open_files(1), probe.cwd(1)), ("1700000000", ["/r/rollout-x.jsonl"], "/w/proj"))
        reading = metrics.read()
        self.assertEqual((reading["mem_used"], reading["cpu_pct"], reading["cpus"], reading["swap_used"]), (60, 12.3, 8, 1))


class ReadonlyUriTest(unittest.TestCase):
    def test_special_characters_in_the_path_stay_literal(self):
        import sqlite3
        from agenttrack.platform import readonly_uri
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "a?b#c%d" / "x.sqlite"
            db.parent.mkdir()
            conn = sqlite3.connect(db)
            conn.execute("CREATE TABLE t (v)")
            conn.commit()
            conn.close()
            ro = sqlite3.connect(readonly_uri(db), uri=True)
            self.assertEqual(ro.execute("SELECT COUNT(*) FROM t").fetchone(), (0,))
            ro.close()


class AgentHomeEnvTest(unittest.TestCase):
    def test_claude_config_dir_and_codex_home_come_first(self):
        env = fake_env("linux", Path("/u"), {"CLAUDE_CONFIG_DIR": "/cfg/claude", "CODEX_HOME": "/cfg/codex"})
        homes = {a.id: a.homes(env) for a in load_adapters([])}
        self.assertEqual(homes["claude"], [Path("/cfg/claude"), Path("/u/.claude")])
        self.assertEqual(homes["codex"], [Path("/cfg/codex"), Path("/u/.codex")])

    def test_defaults_without_the_variables(self):
        homes = {a.id: a.homes(fake_env("linux", Path("/u"), {})) for a in load_adapters([])}
        self.assertEqual((homes["claude"], homes["codex"]), ([Path("/u/.claude")], [Path("/u/.codex")]))


class ConfigTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)

    def env(self, environ=None):
        return fake_env("linux", self.home, environ)

    def write(self, text):
        path = self.env().config_path
        path.parent.mkdir(parents=True)
        path.write_text(text)

    def test_defaults_put_the_database_in_the_os_data_dir(self):
        cfg = config.load(self.env())
        self.assertEqual((cfg.db, cfg.host, cfg.port, cfg.exists), (self.home / ".local/share/agent-track/agent-track.sqlite", "127.0.0.1", 3874, False))

    def test_file_then_environment_override(self):
        self.write('port = 4000\nhost = "localhost"\ndb = "/d/x.sqlite"\n[homes]\nclaude = "/c"\n')
        cfg = config.load(self.env())
        self.assertEqual((cfg.port, cfg.host, cfg.db, cfg.homes), (4000, "localhost", Path("/d/x.sqlite"), {"claude": Path("/c")}))
        cfg = config.load(self.env({"AGENT_TRACK_PORT": "5000", "AGENT_TRACK_DB": "/e.sqlite", "AGENT_TRACK_HOME_CLAUDE": "/env-c", "AGENT_TRACK_HOME_GROK": "/g"}))
        self.assertEqual((cfg.port, cfg.db, cfg.homes), (5000, Path("/e.sqlite"), {"claude": Path("/env-c"), "grok": Path("/g")}))

    def test_bad_toml_or_port_is_a_config_error(self):
        self.write("port = [")
        with self.assertRaises(config.ConfigError):
            config.load(self.env())
        with self.assertRaises(config.ConfigError):
            config.load(self.env({"AGENT_TRACK_PORT": "abc"}))


def run_cli(*argv, env=None):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err), mock.patch.object(cli.Env, "current", return_value=env or fake_env("linux", tempfile.mkdtemp())):
        try:
            cli.main(list(argv))
            code = 0
        except SystemExit as exc:
            code = exc.code
            if isinstance(code, str):
                err.write(code)
                code = 1
    return code, out.getvalue(), err.getvalue()


class DoctorTest(unittest.TestCase):
    def test_json_shape(self):
        home = Path(tempfile.mkdtemp())
        (home / ".claude" / "projects").mkdir(parents=True)
        (home / ".codex").mkdir()
        code, out, _ = run_cli("doctor", "--json", env=fake_env("linux", home, probe=LinuxProc(), metrics=LinuxMetrics()))
        self.assertEqual(code, 0)
        report = json.loads(out)
        self.assertEqual(set(report), {"adapters", "platform", "config", "port"})
        by_id = {a["id"]: a for a in report["adapters"]}
        self.assertEqual(list(by_id), ["claude", "codex", "grok", "t3"])
        for a in by_id.values():
            self.assertEqual(set(a), {"id", "display_name", "detected", "home", "schema_ok", "note", "capabilities"})
        self.assertEqual((by_id["claude"]["detected"], by_id["claude"]["schema_ok"], by_id["claude"]["home"]), (True, True, str(home / ".claude")))
        self.assertEqual((by_id["codex"]["detected"], by_id["codex"]["schema_ok"]), (True, False))
        self.assertEqual((by_id["grok"]["detected"], by_id["grok"]["home"]), (False, None))
        self.assertEqual(by_id["claude"]["capabilities"], ["ingest", "live", "subagents", "titles", "tokens"])
        self.assertEqual(report["platform"], {"os": "linux", "probe": "LinuxProc", "metrics": "LinuxMetrics", "live_status": True,
                                              "machine_view": True, "status_label": "exact"})
        self.assertEqual(set(report["config"]), {"path", "exists", "error", "db", "host", "data_dir"})
        self.assertEqual(set(report["port"]), {"port", "free"})
        self.assertEqual(report["port"]["port"], 3874)

    def test_null_probe_reports_approximate_status_and_no_machine_view(self):
        code, out, _ = run_cli("doctor", "--json")
        platform = json.loads(out)["platform"]
        self.assertEqual((platform["live_status"], platform["machine_view"], platform["status_label"]), (False, False, "approximate (timestamps only)"))

    def test_a_broken_config_is_reported_not_raised(self):
        env = fake_env("linux", tempfile.mkdtemp())
        env.config_path.parent.mkdir(parents=True)
        env.config_path.write_text("port = [")
        code, out, _ = run_cli("doctor", "--json", env=env)
        self.assertEqual(code, 0)
        self.assertIn("cannot read", json.loads(out)["config"]["error"])

    def test_text_output_lists_each_adapter(self):
        code, out, _ = run_cli("doctor")
        self.assertEqual(code, 0)
        for name in ("claude", "codex", "grok", "t3", "database", "port"):
            self.assertIn(name, out)


class LoopbackGuardTest(unittest.TestCase):
    def test_is_loopback(self):
        for host in ("127.0.0.1", "127.9.9.9", "::1", "localhost"):
            self.assertTrue(cli.is_loopback(host), host)
        for host in ("0.0.0.0", "::", "", "192.168.1.5", "example.com", "10.0.0.1"):
            self.assertFalse(cli.is_loopback(host), host)

    def test_serve_refuses_a_remote_host_without_the_flag(self):
        with mock.patch("agenttrack.server.serve") as serve:
            code, _, err = run_cli("serve", "--host", "0.0.0.0")
        self.assertEqual(code, 1)
        self.assertIn("--allow-remote", err)
        serve.assert_not_called()

    def test_serve_with_the_flag_warns_about_prompt_text(self):
        with mock.patch("agenttrack.server.serve") as serve:
            code, _, err = run_cli("serve", "--host", "0.0.0.0", "--allow-remote")
        self.assertEqual(code, 0)
        self.assertIn("prompt text", err)
        self.assertEqual(serve.call_args.args[0], "0.0.0.0")

    def test_serve_binds_loopback_by_default_without_a_warning(self):
        with mock.patch("agenttrack.server.serve") as serve:
            code, _, err = run_cli("serve")
        self.assertEqual((code, err, serve.call_args.args[:2]), (0, "", ("127.0.0.1", 3874)))

    def test_a_remote_host_from_config_is_guarded_too(self):
        env = fake_env("linux", tempfile.mkdtemp(), {"AGENT_TRACK_HOST": "0.0.0.0"})
        with mock.patch("agenttrack.server.serve") as serve:
            code, _, _ = run_cli("serve", env=env)
        self.assertEqual(code, 1)
        serve.assert_not_called()


class NoPlatformLeaksTest(unittest.TestCase):
    def test_only_platform_py_names_the_os(self):
        src = Path(__file__).parent.parent / "src" / "agenttrack"
        banned = ("sys.platform", '"/proc', "Path.home()", "os.name", "platform.system")
        for path in src.rglob("*.py"):
            if path.name == "platform.py":
                continue
            text = path.read_text()
            for needle in banned:
                self.assertNotIn(needle, text, f"{path.name} uses {needle}")


if __name__ == "__main__":
    unittest.main()
