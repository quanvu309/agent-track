"""Per-user background service for `agent-track serve`: a systemd user unit on Linux, a launchd agent on macOS."""

import plistlib
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple

from .platform import Env

UNIT_NAME = "agent-track.service"
LABEL = "dev.agent-track"
EPHEMERAL = re.compile(r"/uv/(archive|builds|environments)-v\d|/pipx/\.cache/|/\.cache/pipx/")


class Plan(NamedTuple):
    path: Path | None  # None: nothing to write (Windows)
    content: str
    enable: list[list[str]]
    disable: list[list[str]]
    notes: list[str]


def agent_track_argv() -> list[str]:
    """How to start this install again: the console script when one exists, else this interpreter with -m."""
    for candidate in (Path(sys.argv[0]), shutil.which("agent-track")):
        if candidate and Path(candidate).name.lower().startswith(("agent-track", "agenttrack")) and Path(candidate).is_file():
            return [str(Path(candidate).absolute())]
    return [sys.executable, "-m", "agenttrack"]


def serve_args(argv: list[str], port: int | None) -> list[str]:
    return [*argv, "serve", *(["--port", str(port)] if port else [])]


def render_systemd(argv: list[str], port: int | None) -> str:
    return (
        "[Unit]\n"
        "Description=agent-track local AI agent activity dashboard\n"
        "After=network.target\n\n"
        "[Service]\n"
        f"ExecStart={shlex.join(serve_args(argv, port))}\n"
        "Restart=on-failure\n"
        "RestartSec=5\n\n"
        "[Install]\n"
        "WantedBy=default.target\n"
    )


def render_launchd(argv: list[str], port: int | None, log: Path) -> str:
    return plistlib.dumps({
        "Label": LABEL,
        "ProgramArguments": serve_args(argv, port),
        "RunAtLoad": True,
        "KeepAlive": True,
        "StandardOutPath": str(log),
        "StandardErrorPath": str(log),
    }).decode()


def make_plan(env: Env, argv: list[str], port: int | None) -> Plan:
    if env.os == "linux":
        path = env.xdg_config / "systemd" / "user" / UNIT_NAME
        return Plan(
            path,
            render_systemd(argv, port),
            [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", UNIT_NAME]],
            [["systemctl", "--user", "disable", "--now", UNIT_NAME]],
            [],
        )
    if env.os == "darwin":
        path = env.home / "Library" / "LaunchAgents" / f"{LABEL}.plist"
        return Plan(
            path,
            render_launchd(argv, port, env.data_dir / "agent-track.log"),
            [["launchctl", "load", "-w", str(path)]],
            [["launchctl", "unload", "-w", str(path)]],
            [],
        )
    command = subprocess.list2cmdline(serve_args(argv, port)).replace('"', '\\"')  # schtasks /TR needs the inner quotes escaped
    return Plan(None, "", [], [], [
        "Windows has no automatic installer yet. To start agent-track at every logon, run in PowerShell:",
        f'  schtasks /Create /SC ONLOGON /TN agent-track /TR "{command}"',
        "Start it now with:  schtasks /Run /TN agent-track",
        "Remove it with:  schtasks /Delete /TN agent-track /F",
    ])


def _shown(cmds: list[list[str]]) -> str:
    return " && ".join(shlex.join(c) for c in cmds)


def run(args, env: Env, argv: list[str] | None = None, runner=subprocess.run, out=print) -> int:
    plan = make_plan(env, argv or agent_track_argv(), args.port)
    if plan.path is None:
        for line in plan.notes:
            out(line)
        return 0
    if args.uninstall:
        out(f"{'would remove' if args.dry_run else 'removing'} {plan.path}")
        if args.dry_run:
            return 0
        if plan.path.is_file():
            for cmd in plan.disable:  # launchctl unload and systemctl disable both need the unit file to still exist
                try:
                    runner(cmd, check=False)
                except OSError as exc:
                    out(f"could not run {_shown([cmd])}: {exc}")
        plan.path.unlink(missing_ok=True)
        return 0
    if args.dry_run:
        out(f"would write {plan.path}\n{plan.content}")
        out(f"then enable with: {_shown(plan.enable)}")
        return 0
    if EPHEMERAL.search(" ".join(argv or agent_track_argv()).replace("\\", "/")):
        out("warning: this command runs from a temporary uv or pipx cache and the service will break when it is pruned. Run `pipx install agent-track-cli` first, then install-service again.")
    current = plan.path.read_text(encoding="utf-8") if plan.path.is_file() else None
    if current == plan.content:
        out(f"{plan.path} already up to date")
    else:
        plan.path.parent.mkdir(parents=True, exist_ok=True)
        plan.path.write_text(plan.content, encoding="utf-8")
        if env.os == "darwin":
            env.data_dir.mkdir(parents=True, exist_ok=True)  # launchd will not create the log directory
        out(f"wrote {plan.path}")
    if args.enable:
        for cmd in plan.enable:
            runner(cmd, check=True)
        out("enabled and started")
    else:
        out(f"enable with: {_shown(plan.enable)}")
    return 0
