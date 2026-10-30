"""Copy the bundled agent skills into the skill directories of the agents installed for this user."""

from importlib import resources
from importlib.resources.abc import Traversable
from pathlib import Path

from .platform import Env

AGENT_DIRS = (".claude", ".codex", ".agents")


def bundled() -> Traversable:
    return resources.files("agenttrack") / "skill"


def default_dests(env: Env) -> list[Path]:
    """<agent dir>/skills for each agent dir that already exists. A missing agent is not an error."""
    return [env.home / d / "skills" for d in AGENT_DIRS if (env.home / d).is_dir()]


def _files(node: Traversable, rel: Path = Path()):
    for child in sorted(node.iterdir(), key=lambda c: c.name):
        if child.name == "__pycache__":
            continue
        if child.is_dir():
            yield from _files(child, rel / child.name)
        else:
            yield rel / child.name, child


def install(dests: list[Path], dry_run: bool = False, force: bool = False, source: Traversable | None = None) -> list[dict]:
    """One result per file: status is created, unchanged, updated (forced), conflict (differs, not forced)."""
    results = []
    for dest in dests:
        for rel, node in _files(source or bundled()):
            target = dest / rel
            data = node.read_bytes()
            if not target.exists():
                status = "created"
            elif target.read_bytes() == data:
                status = "unchanged"
            else:
                status = "updated" if force else "conflict"
            if status in ("created", "updated") and not dry_run:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            results.append({"path": str(target), "status": status})
    return results


def run(args, env: Env, out=print) -> int:
    dests = [Path(d).expanduser() for d in args.dest] if args.dest else default_dests(env)
    if not dests:
        out("no skill directory found (none of ~/.claude, ~/.codex, ~/.agents exists). Pass --dest DIR to choose one.")
        return 0
    results = install(dests, args.dry_run, args.force)
    for r in results:
        out(f"{'would be ' if args.dry_run and r['status'] in ('created', 'updated') else ''}{r['status']:<9} {r['path']}")
    conflicts = [r for r in results if r["status"] == "conflict"]
    if conflicts:
        out(f"{len(conflicts)} file(s) differ from the bundled copy and were left alone. Rerun with --force to overwrite them.")
        return 1
    return 0
