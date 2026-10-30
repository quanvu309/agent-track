"""`agent-track adapter check`: load an adapter and validate it against the contract in adapters/base.py."""

import importlib
import importlib.util
import inspect
import re
import sys
from pathlib import Path

from .adapters import Cap, Detection, LiveScan
from .model import Event, Parsed, Thread
from .platform import Env

TS = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
KINDS = {"prompt", "tool_call", "response"}
REQUIRED = {
    Cap.INGEST: ("units", "members", "parse"),
    Cap.TITLES: ("titles",),
    Cap.LIVE: ("live",),
}
# Fields a unit of each event kind is expected to fill, beyond project and model.
EVENT_FIELDS = {"prompt": ("text",), "tool_call": ("tool", "failed", "duration_ms"), "response": ("input_tokens", "cached_tokens", "output_tokens")}
THREAD_FIELDS = ("project", "title", "model", "started_at")


class CheckError(Exception):
    pass


def _dotted_name(path: Path) -> tuple[str, Path]:
    """Package-qualified module name when the file sits in a package, so its relative imports resolve."""
    parts, folder = [path.stem], path.parent
    while (folder / "__init__.py").is_file():
        parts.append(folder.name)
        folder = folder.parent
    return ".".join(reversed(parts)), folder


def _load_module(target: str):
    path = Path(target).expanduser()
    if path.is_file():
        name, root = _dotted_name(path)
        if "." in name:
            try:
                importlib.import_module(name.rsplit(".", 1)[0])
            except ImportError:
                sys.path.insert(0, str(root))
        else:
            name = f"agenttrack_check_{path.stem}"
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except Exception as exc:
            raise CheckError(f"importing {path} failed: {exc!r}") from exc
        return module
    try:
        return importlib.import_module(target)
    except ImportError as exc:
        raise CheckError(f"cannot load {target!r}: {exc}. Pass a path to an adapter .py file or module:Class.") from exc


def load_adapter(spec: str):
    """spec is a .py path or a module name, optionally followed by :ClassName. Without a class, use ADAPTER or the only adapter-shaped class."""
    target, _, cls_name = spec.rpartition(":")
    if not target or "/" in cls_name or "\\" in cls_name:  # no colon, or a Windows drive letter
        target, cls_name = spec, ""
    module = _load_module(target)
    if cls_name:
        if not hasattr(module, cls_name):
            raise CheckError(f"{target} has no attribute {cls_name!r}")
        obj = getattr(module, cls_name)
    elif hasattr(module, "ADAPTER"):
        obj = module.ADAPTER
    else:
        shaped = [c for _, c in inspect.getmembers(module, inspect.isclass) if c.__module__ == module.__name__ and hasattr(c, "capabilities") and hasattr(c, "detect")]
        if len(shaped) != 1:
            raise CheckError(f"{target} defines no ADAPTER and {len(shaped)} adapter-shaped classes. Add ADAPTER = YourAdapter() or pass module:Class.")
        obj = shaped[0]
    try:
        return obj() if inspect.isclass(obj) else obj
    except Exception as exc:
        raise CheckError(f"constructing the adapter failed: {exc!r}") from exc


def _check_shape(adapter, errors: list[str]) -> None:
    if not isinstance(getattr(adapter, "id", None), str) or not adapter.id:
        errors.append("id must be a non-empty string")
    if not isinstance(getattr(adapter, "display_name", None), str) or not adapter.display_name:
        errors.append("display_name must be a non-empty string")
    caps = getattr(adapter, "capabilities", None)
    if not isinstance(caps, (set, frozenset)) or not caps or not all(isinstance(c, Cap) for c in caps):
        errors.append("capabilities must be a non-empty frozenset of Cap")
        caps = frozenset()
    names = getattr(adapter, "process_names", None)
    if not isinstance(names, tuple) or not all(isinstance(n, str) for n in names):
        errors.append("process_names must be a tuple of str")
    for method in ("homes", "detect"):
        if not callable(getattr(adapter, method, None)):
            errors.append(f"missing method {method}()")
    for cap in caps:
        for method in REQUIRED.get(cap, ()):
            if not callable(getattr(adapter, method, None)):
                errors.append(f"declares Cap.{cap.name} but method {method}() is missing")


def _check_parsed(adapter, unit, parsed, errors: list[str]) -> None:
    if not isinstance(parsed, Parsed):
        errors.append(f"parse({unit}) returned {type(parsed).__name__}, expected model.Parsed")
        return
    for e in parsed.events:
        if not isinstance(e, Event):
            errors.append(f"parse({unit}): events must be model.Event rows")
            return
        if e.kind not in KINDS:
            errors.append(f"parse({unit}): event kind {e.kind!r} not in {sorted(KINDS)}")
        if not TS.match(str(e.ts)):
            errors.append(f"parse({unit}): ts {e.ts!r} is not UTC ISO with milliseconds (use model.norm_ts)")
        if e.harness != adapter.id:
            errors.append(f"parse({unit}): event harness {e.harness!r} differs from adapter id {adapter.id!r}")
    for t in parsed.threads:
        if not isinstance(t, Thread):
            errors.append(f"parse({unit}): threads must be model.Thread rows")
            return
        if t.harness != adapter.id:
            errors.append(f"parse({unit}): thread harness {t.harness!r} differs from adapter id {adapter.id!r}")


def _all_none(threads: list, events: list) -> dict[str, list[str]]:
    found = {}
    if threads:
        found["thread"] = [f for f in THREAD_FIELDS if all(getattr(t, f) is None for t in threads)]
    for kind, fields in EVENT_FIELDS.items():
        rows = [e for e in events if e.kind == kind]
        if rows:
            found[kind] = [f for f in (*fields, "project", "model") if all(getattr(e, f) is None for e in rows)]
    return {k: v for k, v in found.items() if v}


def check(adapter, env: Env, home: Path | None, limit: int = 5) -> dict:
    errors: list[str] = []
    warnings: list[str] = []
    report = {"adapter": getattr(adapter, "id", None), "ok": False, "errors": errors, "warnings": warnings, "units_parsed": 0,
              "threads": 0, "events": 0, "edges": 0, "all_none_fields": {}}
    _check_shape(adapter, errors)
    if any(not e.startswith("declares") for e in errors):
        return report
    caps = adapter.capabilities
    if home is not None:
        env = env.with_overrides({adapter.id: home})
    try:
        detection = adapter.detect(env)
    except Exception as exc:
        errors.append(f"detect() raised {exc!r}")
        return report
    if not isinstance(detection, Detection):
        errors.append(f"detect() returned {type(detection).__name__}, expected Detection")
        return report
    if detection.adapter_id != adapter.id:
        errors.append(f"detect() adapter_id {detection.adapter_id!r} differs from id {adapter.id!r}")
    if home is not None and detection.home is None:
        errors.append(f"detect() found no data under --home {home}: {detection.note}. homes() should return candidate_homes(id, env, ...) so overrides apply")
    elif home is not None and not detection.schema_ok:
        errors.append(f"detect() reports schema_ok=False for the fixture: {detection.note}")
    elif home is None and detection.home is None:
        warnings.append("no data directory on this machine and no --home given, so units and parse were not exercised")
    data_home = detection.home
    if data_home is None:
        report["ok"] = not errors
        return report

    threads, events, edges = [], [], 0
    has = lambda *names: all(callable(getattr(adapter, n, None)) for n in names)  # noqa: E731
    if Cap.INGEST in caps and has(*REQUIRED[Cap.INGEST]):
        try:
            units = []
            for unit in adapter.units(data_home):
                units.append(unit)
                if len(units) >= limit:
                    break
        except Exception as exc:
            errors.append(f"units() raised {exc!r}")
            units = []
        if not units:
            warnings.append("units() yielded nothing, so parse() was not exercised")
        for unit in units:
            try:
                members = adapter.members(unit)
                if not isinstance(members, list) or not all(isinstance(m, Path) for m in members):
                    errors.append(f"members({unit}) must return list[Path]")
                parsed = adapter.parse(unit)
            except Exception as exc:
                errors.append(f"parse({unit}) raised {exc!r}")
                continue
            _check_parsed(adapter, unit, parsed, errors)
            if isinstance(parsed, Parsed):
                threads += parsed.threads
                events += parsed.events
                edges += len(parsed.edges)
                report["units_parsed"] += 1
        if units and Cap.TOKENS in caps and events and not any(e.input_tokens is not None or e.output_tokens is not None for e in events):
            errors.append("declares Cap.TOKENS but no parsed event has token counts")
        if units and Cap.SUBAGENTS in caps and not edges and not any(t.parent_thread_id for t in threads):
            warnings.append("declares Cap.SUBAGENTS but no sampled unit has a sub-thread (add one to the fixtures)")
    if Cap.TITLES in caps and has("titles"):
        try:
            titles = adapter.titles(data_home)
            if not isinstance(titles, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in titles.items()):
                errors.append("titles() must return dict[str, str]")
        except Exception as exc:
            errors.append(f"titles() raised {exc!r}")
    if Cap.LIVE in caps and has("live"):
        try:
            scan = adapter.live(data_home, env.probe)
            if not isinstance(scan, LiveScan):
                errors.append(f"live() returned {type(scan).__name__}, expected LiveScan")
        except Exception as exc:
            errors.append(f"live() raised {exc!r}")
    report.update(threads=len(threads), events=len(events), edges=edges, all_none_fields=_all_none(threads, events))
    for scope, fields in report["all_none_fields"].items():
        warnings.append(f"{scope}: always None in the sample: {', '.join(fields)}")
    report["ok"] = not errors
    return report


def run(args, env: Env, out=print) -> int:
    import json

    try:
        adapter = load_adapter(args.target)
    except CheckError as exc:
        out(f"FAIL {exc}")
        return 1
    report = check(adapter, env, Path(args.home).expanduser() if args.home else None, args.limit)
    if args.json:
        out(json.dumps(report, indent=2))
    else:
        out(f"{'PASS' if report['ok'] else 'FAIL'} adapter {report['adapter']!r}: {report['units_parsed']} units parsed, "
            f"{report['threads']} threads, {report['events']} events, {report['edges']} edges")
        for message in report["errors"]:
            out(f"  error: {message}")
        for message in report["warnings"]:
            out(f"  note: {message}")
    return 0 if report["ok"] else 1
