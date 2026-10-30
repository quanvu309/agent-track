import argparse
import ipaddress
import json
import socket
import sqlite3
import sys

from . import config as config_mod
from . import check as check_mod
from . import queries, service, skills, store
from .adapters import load_adapters
from .platform import Env

REMOTE_WARNING = "WARNING: serving beyond loopback. Everything this dashboard stores, including prompt text, is readable by anyone who can reach the port."


def _print_table(rows: list[dict], columns: list[str]) -> None:
    cells = [[f"{r[c]:,}" if isinstance(r[c], int) else str(r[c]) for c in columns] for r in rows]
    widths = [max(len(c), *(len(row[i]) for row in cells)) if cells else len(c) for i, c in enumerate(columns)]
    print("  ".join(c.ljust(w) if i < 2 else c.rjust(w) for i, (c, w) in enumerate(zip(columns, widths))))
    for row in cells:
        print("  ".join(v.ljust(w) if i < 2 and not v[:1].isdigit() else v.rjust(w) for i, (v, w) in enumerate(zip(row, widths))))
    print()


def is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _setup(args):
    env = Env.current()
    try:
        cfg = config_mod.load(env)
    except config_mod.ConfigError as exc:
        sys.exit(f"agent-track: {exc}")
    return env.with_overrides(cfg.homes), cfg, load_adapters()


def cmd_ingest(args) -> None:
    env, cfg, adapters = _setup(args)
    conn = store.connect(args.db or cfg.db)
    stats = store.ingest(conn, log=lambda m: print(m, file=sys.stderr), adapters=adapters, env=env)
    print(f"ingest: {stats['parsed']} parsed, {stats['unchanged']} unchanged, {stats['removed']} removed, {stats['skipped']} failed of {stats['units']} units in {stats['duration_ms']} ms\n")
    report = queries.cli_report(conn)
    print("Totals per harness")
    _print_table(report["totals"], ["harness", "sessions", "input_tokens", "cached_tokens", "output_tokens", "prompts", "tool_calls", "responses"])
    print("Per local day and harness")
    _print_table(report["daily"], ["day", "harness", "sessions", "prompts", "tool_calls", "responses", "input_tokens", "output_tokens"])
    print("Tokens per harness and model")
    _print_table(report["models"], ["harness", "model", "responses", "input_tokens", "cached_tokens", "output_tokens"])


def cmd_serve(args) -> None:
    from .server import serve

    env, cfg, adapters = _setup(args)
    host = args.host or cfg.host
    if not is_loopback(host):
        if not args.allow_remote:
            sys.exit(f"agent-track: refusing to bind {host!r}: not a loopback address. Pass --allow-remote to serve it anyway.")
        print(REMOTE_WARNING, file=sys.stderr)
    serve(host, args.port or cfg.port, args.db or cfg.db, env, adapters, {}, args.allow_remote)


def _port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host, port))
        except OSError:
            return False
    return True


def doctor_report(env: Env, cfg: config_mod.Config | None, adapters, config_error: str | None = None) -> dict:
    found = []
    for adapter in adapters:
        d = adapter.detect(env)
        found.append({
            "id": adapter.id,
            "display_name": adapter.display_name,
            "detected": d.home is not None,
            "home": str(d.home) if d.home else None,
            "schema_ok": d.schema_ok,
            "note": d.note,
            "capabilities": sorted(c.value for c in adapter.capabilities),
        })
    probe, metrics = env.probe, env.metrics
    host = cfg.host if cfg else config_mod.DEFAULT_HOST
    port = cfg.port if cfg else config_mod.DEFAULT_PORT
    return {
        "adapters": found,
        "platform": {
            "os": env.os,
            "probe": probe.name,
            "metrics": metrics.name,
            "live_status": probe.available,
            "machine_view": probe.available and metrics.available,
            "status_label": "exact" if probe.available else "approximate (timestamps only)",
        },
        "config": {
            "path": str(env.config_path),
            "exists": cfg.exists if cfg else env.config_path.is_file(),
            "error": config_error,
            "db": str(cfg.db) if cfg else str(env.default_db),
            "host": host,
            "data_dir": str(env.data_dir),
        },
        "port": {"port": port, "free": _port_free(host, port) if is_loopback(host) else None},
    }


def cmd_doctor(args) -> None:
    env = Env.current()
    cfg, error = None, None
    try:
        cfg = config_mod.load(env)
        env = env.with_overrides(cfg.homes)
    except config_mod.ConfigError as exc:
        error = str(exc)
    report = doctor_report(env, cfg, load_adapters(), error)
    if args.json:
        print(json.dumps(report, indent=2))
        return
    print(f"platform  {report['platform']['os']}  probe={report['platform']['probe']}  status={report['platform']['status_label']}  machine view={'on' if report['platform']['machine_view'] else 'off'}")
    for a in report["adapters"]:
        state = "ok" if a["detected"] and a["schema_ok"] else ("found, unexpected layout" if a["detected"] else "not found")
        print(f"  {a['id']:<8} {state:<24} {a['home'] or '-'}  [{', '.join(a['capabilities'])}]" + (f"  ({a['note']})" if a["note"] else ""))
    c = report["config"]
    print(f"config    {c['path']} ({'present' if c['exists'] else 'absent'})" + (f"  ERROR {c['error']}" if c["error"] else ""))
    print(f"database  {c['db']}")
    p = report["port"]
    print(f"port      {c['host']}:{p['port']} {'free' if p['free'] else 'in use' if p['free'] is False else 'not checked'}")


def cmd_install_service(args) -> None:
    sys.exit(service.run(args, Env.current()))


def cmd_skill_install(args) -> None:
    sys.exit(skills.run(args, Env.current()))


def cmd_query(args) -> None:
    env, cfg, _ = _setup(args)
    db = args.db or cfg.db
    try:
        conn = store.connect(db, readonly=True)
        if args.what == "totals":
            result = queries.summary(conn)
        else:
            result = {"sessions": queries.sessions(conn, limit=args.limit)}
    except sqlite3.Error as exc:
        sys.exit(f"agent-track: cannot read {db}: {exc}. Run `agent-track ingest` first.")
    print(json.dumps(result, default=str))


def cmd_adapter_check(args) -> None:
    sys.exit(check_mod.run(args, Env.current()))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="agent-track")
    parser.add_argument("--db", default=None, help="SQLite path (default: config, else the OS data dir)")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("ingest", help="one incremental ingest, print totals").set_defaults(run=cmd_ingest)
    serve = sub.add_parser("serve", help="ingest every 60 s and serve the dashboard")
    serve.add_argument("--host", default=None)
    serve.add_argument("--port", type=int, default=None)
    serve.add_argument("--allow-remote", action="store_true", help="allow a non-loopback host (data includes prompt text)")
    serve.set_defaults(run=cmd_serve)
    doctor = sub.add_parser("doctor", help="report which agents, paths and OS probes were found")
    doctor.add_argument("--json", action="store_true")
    doctor.set_defaults(run=cmd_doctor)
    svc = sub.add_parser("install-service", help="run `serve` at login as a systemd user unit (Linux) or launchd agent (macOS)")
    svc.add_argument("--port", type=int, default=None, help="pass --port to serve (default: config, else 3874)")
    svc.add_argument("--dry-run", action="store_true", help="print what would be written, write nothing")
    svc.add_argument("--uninstall", action="store_true", help="remove the service file")
    svc.add_argument("--enable", action="store_true", help="also run systemctl --user enable --now / launchctl load (with --uninstall: the matching stop)")
    svc.set_defaults(run=cmd_install_service)
    skill = sub.add_parser("skill", help="manage the bundled agent skills")
    skill_sub = skill.add_subparsers(dest="skill_command", required=True)
    skill_install = skill_sub.add_parser("install", help="copy the bundled skills into ~/.claude, ~/.codex, ~/.agents skills dirs that exist")
    skill_install.add_argument("--dest", action="append", default=[], metavar="DIR", help="skills directory to install into (repeatable); replaces the defaults")
    skill_install.add_argument("--dry-run", action="store_true")
    skill_install.add_argument("--force", action="store_true", help="overwrite files that differ from the bundled copy")
    skill_install.set_defaults(run=cmd_skill_install)
    query = sub.add_parser("query", help="print store contents as JSON on stdout")
    query_sub = query.add_subparsers(dest="what", required=True)
    query_sub.add_parser("totals", help="per-harness totals plus last ingest time")
    recent = query_sub.add_parser("recent", help="most recently active sessions")
    recent.add_argument("--limit", type=int, default=10)
    query.set_defaults(run=cmd_query)
    adapter = sub.add_parser("adapter", help="adapter tooling")
    adapter_sub = adapter.add_subparsers(dest="adapter_command", required=True)
    adapter_check = adapter_sub.add_parser("check", help="validate an adapter against the contract; exit 1 on failure")
    adapter_check.add_argument("target", help="path to an adapter .py file, or module:Class")
    adapter_check.add_argument("--home", default=None, help="fixture data directory to run detect() and parse() against")
    adapter_check.add_argument("--limit", type=int, default=5, help="parse at most this many units")
    adapter_check.add_argument("--json", action="store_true")
    adapter_check.set_defaults(run=cmd_adapter_check)
    args = parser.parse_args(argv)
    args.run(args)
