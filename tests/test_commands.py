import io
import json
import plistlib
import shutil
import sys
import tempfile
import unittest
from argparse import Namespace
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from agenttrack import check, cli, service, skills, store
from agenttrack.adapters.grok import GrokAdapter
from agenttrack.platform import Env
from helpers import FIXTURES, IngestCase

TESTS = Path(__file__).parent
ARGV = ["/opt/at/bin/agent-track"]
FAKE_HOME = Path("/Users/someone")


def fake_env(os_name: str, home: Path) -> Env:
    return Env.current(environ={}, platform=os_name, home=home)


class TempHome(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)


def service_args(**kw):
    return Namespace(port=None, dry_run=False, uninstall=False, enable=False, **kw)


class InstallService(TempHome):
    def test_linux_unit(self):
        plan = service.make_plan(fake_env("linux", FAKE_HOME), ARGV, 4000)
        self.assertEqual(plan.path, FAKE_HOME / ".config/systemd/user/agent-track.service")
        self.assertIn("ExecStart=/opt/at/bin/agent-track serve --port 4000\n", plan.content)
        self.assertIn("WantedBy=default.target", plan.content)
        self.assertNotIn(str(Path.home()), plan.content + str(plan.path))

    def test_darwin_plist(self):
        plan = service.make_plan(fake_env("darwin", FAKE_HOME), ARGV, None)
        self.assertEqual(plan.path, FAKE_HOME / "Library/LaunchAgents/dev.agent-track.plist")
        data = plistlib.loads(plan.content.encode())
        self.assertEqual(data["Label"], "dev.agent-track")
        self.assertEqual(data["ProgramArguments"], [*ARGV, "serve"])
        self.assertNotIn(str(Path.home()), plan.content)

    def test_paths_with_spaces_are_quoted(self):
        text = service.render_systemd(["/opt/my tools/agent-track"], None)
        self.assertIn("ExecStart='/opt/my tools/agent-track' serve\n", text)

    def test_windows_prints_manual_steps_and_exits_zero(self):
        lines = []
        self.assertEqual(service.run(service_args(), fake_env("windows", self.tmp), ARGV, out=lines.append), 0)
        self.assertTrue(any("schtasks /Create" in line for line in lines))
        self.assertEqual(list(self.tmp.rglob("*")), [])

    def test_dry_run_writes_nothing(self):
        lines = []
        args = service_args()
        args.dry_run = True
        service.run(args, fake_env("linux", self.tmp), ARGV, out=lines.append)
        self.assertEqual(list(self.tmp.rglob("*")), [])
        self.assertIn("systemctl --user enable --now agent-track.service", "\n".join(lines))

    def test_write_is_idempotent_and_enable_runs_commands(self):
        env = fake_env("linux", self.tmp)
        service.run(service_args(), env, ARGV, out=lambda m: None)
        ran = []
        args = service_args()
        args.enable = True
        lines = []
        service.run(args, env, ARGV, runner=lambda cmd, check: ran.append(cmd), out=lines.append)
        self.assertTrue(any("already up to date" in m for m in lines))
        self.assertEqual(ran[-1], ["systemctl", "--user", "enable", "--now", "agent-track.service"])

    def test_uninstall_removes_file(self):
        env = fake_env("darwin", self.tmp)
        service.run(service_args(), env, ARGV, out=lambda m: None)
        args = service_args()
        args.uninstall = True
        service.run(args, env, ARGV, runner=lambda cmd, check: None, out=lambda m: None)
        self.assertFalse((self.tmp / "Library/LaunchAgents/dev.agent-track.plist").exists())

    def test_uninstall_stops_the_service_while_the_unit_file_still_exists(self):
        env = fake_env("darwin", self.tmp)
        service.run(service_args(), env, ARGV, out=lambda m: None)
        plist = self.tmp / "Library/LaunchAgents/dev.agent-track.plist"
        seen = []
        args = service_args()
        args.uninstall = True
        service.run(args, env, ARGV, runner=lambda cmd, check: seen.append((cmd[0], plist.exists())), out=lambda m: None)
        self.assertEqual(seen, [("launchctl", True)])
        self.assertFalse(plist.exists())

    def test_windows_task_command_escapes_inner_quotes_for_paths_with_spaces(self):
        plan = service.make_plan(fake_env("windows", self.tmp), [r"C:\Users\John Smith\bin\agent-track.exe"], None)
        create = next(line for line in plan.notes if "/Create" in line)
        self.assertIn(r'/TR "\"C:\Users\John Smith\bin\agent-track.exe\" serve"', create)

    def test_darwin_install_creates_the_log_directory(self):
        env = fake_env("darwin", self.tmp)
        service.run(service_args(), env, ARGV, out=lambda m: None)
        self.assertTrue(env.data_dir.is_dir())

    def test_a_temporary_cache_path_gets_a_warning(self):
        lines = []
        service.run(service_args(), fake_env("linux", self.tmp), ["/u/.cache/uv/archive-v0/abc/bin/agent-track"], out=lines.append)
        self.assertTrue(any(m.startswith("warning:") for m in lines))

    def test_default_argv_is_absolute(self):
        argv = service.agent_track_argv()
        self.assertTrue(Path(argv[0]).is_absolute())


class SkillInstall(TempHome):
    def run_install(self, **kw):
        env = fake_env("linux", self.tmp)
        args = Namespace(dest=kw.get("dest", []), dry_run=kw.get("dry_run", False), force=kw.get("force", False))
        lines = []
        return skills.run(args, env, out=lines.append), lines

    def test_only_existing_agent_dirs(self):
        (self.tmp / ".claude").mkdir()
        (self.tmp / ".agents").mkdir()
        dests = skills.default_dests(fake_env("linux", self.tmp))
        self.assertEqual(dests, [self.tmp / ".claude/skills", self.tmp / ".agents/skills"])

    def test_no_dirs_exits_zero(self):
        rc, lines = self.run_install()
        self.assertEqual(rc, 0)
        self.assertIn("--dest", lines[0])

    def test_dry_run_then_real_then_idempotent(self):
        dest = self.tmp / "out"
        rc, _ = self.run_install(dest=[str(dest)], dry_run=True)
        self.assertEqual((rc, dest.exists()), (0, False))
        self.run_install(dest=[str(dest)])
        self.assertTrue((dest / "agent-track-setup/SKILL.md").is_file())
        rc, lines = self.run_install(dest=[str(dest)])
        self.assertEqual(rc, 0)
        self.assertTrue(all(line.startswith("unchanged") for line in lines))

    def test_refuses_to_overwrite_a_differing_file(self):
        dest = self.tmp / "out"
        self.run_install(dest=[str(dest)])
        target = dest / "agent-track-setup/SKILL.md"
        target.write_text("mine")
        rc, lines = self.run_install(dest=[str(dest)])
        self.assertEqual((rc, target.read_text()), (1, "mine"))
        self.assertIn("--force", lines[-1])
        rc, _ = self.run_install(dest=[str(dest)], force=True)
        self.assertEqual(rc, 0)
        self.assertNotEqual(target.read_text(), "mine")


class QueryCommands(IngestCase):
    def run_query(self, *argv):
        out = io.StringIO()
        with redirect_stdout(out), mock.patch.object(cli, "_setup", return_value=(None, mock.Mock(db=self.tmp / "agenttrack.sqlite"), [])):
            cli.main(["query", *argv])
        return json.loads(out.getvalue())

    def test_totals_and_recent_are_valid_json(self):
        self.ingest()
        totals = self.run_query("totals")
        self.assertEqual({h["harness"] for h in totals["harnesses"]}, {"claude", "codex", "grok"})
        self.assertIsNotNone(totals["last_ingest"])
        recent = self.run_query("recent", "--limit", "2")
        self.assertEqual(len(recent["sessions"]), 2)

    def test_missing_db_fails_without_stdout(self):
        out = io.StringIO()
        with redirect_stdout(out), mock.patch.object(cli, "_setup", return_value=(None, mock.Mock(db=self.tmp / "nope" / "x.sqlite"), [])):
            with self.assertRaises(SystemExit) as cm:
                cli.main(["query", "totals"])
        self.assertIn("agent-track ingest", str(cm.exception))
        self.assertEqual(out.getvalue(), "")


class AdapterCheck(unittest.TestCase):
    def env(self):
        return Env.current(environ={}, platform="linux", home=Path(tempfile.gettempdir()))

    def test_builtin_adapters_pass(self):
        for name, cls in (("claude", "ClaudeAdapter"), ("codex", "CodexAdapter"), ("grok", "GrokAdapter")):
            with self.subTest(name):
                adapter = check.load_adapter(f"agenttrack.adapters.{name}:{cls}")
                report = check.check(adapter, self.env(), FIXTURES / name)
                self.assertEqual(report["errors"], [])
                self.assertTrue(report["ok"])
                self.assertGreater(report["events"], 0)

    def test_path_loading_resolves_relative_imports(self):
        adapter = check.load_adapter(str(Path(check.__file__).parent / "adapters" / "claude.py"))
        self.assertEqual(adapter.id, "claude")

    def test_broken_toy_adapter_fails_clearly(self):
        home = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        (home / "one.txt").write_text("x")
        adapter = check.load_adapter(str(TESTS / "toy_adapter_broken.py"))
        report = check.check(adapter, self.env(), home)
        self.assertFalse(report["ok"])
        text = "\n".join(report["errors"])
        self.assertIn("declares Cap.TITLES but method titles() is missing", text)
        self.assertIn("'yesterday' is not UTC ISO", text)

    def test_cli_exit_codes(self):
        out = io.StringIO()
        with redirect_stdout(out):
            with self.assertRaises(SystemExit) as ok:
                cli.main(["adapter", "check", "agenttrack.adapters.claude:ClaudeAdapter", "--home", str(FIXTURES / "claude")])
            with self.assertRaises(SystemExit) as bad:
                cli.main(["adapter", "check", str(TESTS / "toy_adapter_broken.py")])
            with self.assertRaises(SystemExit) as missing:
                cli.main(["adapter", "check", "/nonexistent/adapter.py"])
        self.assertEqual((ok.exception.code, bad.exception.code, missing.exception.code), (0, 1, 1))
        self.assertIn("FAIL", out.getvalue())

    def test_all_none_fields_are_reported(self):
        adapter = check.load_adapter("agenttrack.adapters.codex:CodexAdapter")
        report = check.check(adapter, self.env(), FIXTURES / "codex")
        self.assertEqual(report["all_none_fields"], {"thread": ["title"]})


class NoRollup(GrokAdapter):
    rollup_edges = False


class RollupProperty(IngestCase):
    def sessions(self, adapters):
        store.ingest(self.conn, self.homes, adapters=adapters)
        return self.rows("SELECT COUNT(DISTINCT session_id) FROM threads WHERE harness='grok'")[0][0]

    def test_rollup_follows_the_adapter_flag(self):
        from agenttrack.adapters import load_adapters

        stock = [a for a in load_adapters(entry_points=[]) if a.id != "grok"]
        rolled = self.sessions([*stock, GrokAdapter()])
        self.conn.execute("DELETE FROM files")
        flat = self.sessions([*stock, NoRollup()])
        self.assertLess(rolled, flat)
