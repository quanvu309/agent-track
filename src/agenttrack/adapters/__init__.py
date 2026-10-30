"""Adapter registry. Built-ins are the modules in this package that define ADAPTER; third parties register an entry point
in the group `agent_track.adapters` that resolves to an adapter instance, class or zero-argument factory."""

import importlib
import logging
import pkgutil
from importlib import metadata
from pathlib import Path

from ..platform import Env
from .base import ENDED, IDLE, WORKING, Adapter, Cap, Detection, LiveScan, LiveSession, Unit, candidate_homes, detect_home

__all__ = ["ENDED", "IDLE", "WORKING", "Adapter", "Cap", "Detection", "LiveScan", "LiveSession", "Unit", "candidate_homes",
           "detect_home", "load_adapters", "resolve_homes", "GROUP"]

GROUP = "agent_track.adapters"
log = logging.getLogger("agenttrack")

_REQUIRED = ("id", "display_name", "capabilities", "process_names", "homes", "detect")


def _builtins() -> list[Adapter]:
    found = []
    for info in sorted(pkgutil.iter_modules(__path__), key=lambda i: i.name):
        if info.name == "base":
            continue
        try:
            found.append(importlib.import_module(f"{__name__}.{info.name}").ADAPTER)
        except Exception as exc:
            log.warning("built-in adapter %s skipped: %r", info.name, exc)
    return found


def _plugins(entry_points) -> list[Adapter]:
    found = []
    for ep in entry_points:
        try:
            obj = ep.load()
            adapter = obj() if isinstance(obj, type) or (callable(obj) and not hasattr(obj, "id")) else obj
            missing = [a for a in _REQUIRED if not hasattr(adapter, a)]
            if missing:
                raise TypeError(f"missing {', '.join(missing)}")
            found.append(adapter)
        except Exception as exc:
            log.warning("adapter plugin %s skipped: %r", getattr(ep, "name", ep), exc)
    return found


def load_adapters(entry_points=None) -> list[Adapter]:
    """Built-ins first, then plugins. A broken plugin warns and is skipped. A duplicate id keeps the first."""
    if entry_points is None:
        entry_points = metadata.entry_points(group=GROUP)
    adapters: dict[str, Adapter] = {}
    for adapter in [*_builtins(), *_plugins(entry_points)]:
        if adapter.id in adapters:
            log.warning("adapter id %r already registered, duplicate skipped", adapter.id)
            continue
        adapters[adapter.id] = adapter
    return list(adapters.values())


def resolve_homes(adapters: list[Adapter], env: Env, homes: dict[str, Path] | None = None) -> dict[str, Path]:
    """adapter id -> data directory. `homes` wins, then the first existing candidate, then the first candidate."""
    homes = homes or {}
    resolved = {}
    for adapter in adapters:
        if adapter.id in homes:
            resolved[adapter.id] = Path(homes[adapter.id])
            continue
        candidates = adapter.homes(env)
        home = next((c for c in candidates if c.is_dir()), candidates[0] if candidates else None)
        if home is not None:
            resolved[adapter.id] = home
    return resolved
