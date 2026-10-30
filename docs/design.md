# agent-track design

Goal: read the session data of many coding agents, on Linux, macOS and Windows, and show it in one local dashboard. A user's own agent installs and configures it.

## Adapter contract (src/agenttrack/adapters/)

One file per agent. Adding an agent must touch exactly one file (plus, for third parties, an entry point).

```python
class Cap(Enum): INGEST; TITLES; SUBAGENTS; TOKENS; LIVE

class Detection(NamedTuple): adapter_id: str; home: Path | None; schema_ok: bool; note: str | None

class Adapter(Protocol):
    id: str; display_name: str
    capabilities: frozenset[Cap]
    process_names: tuple[str, ...]
    rollup_edges: bool = False   # optional. True: Edge rows nest sub-threads under their root session (store rolls them up)
    def homes(self, env: Env) -> list[Path]: ...
    def detect(self, env: Env) -> Detection: ...
    def units(self, home: Path) -> Iterable[Unit]: ...
    def members(self, unit) -> list[Path]: ...
    def parse(self, unit) -> Parsed: ...          # model.Parsed, unchanged
    def titles(self, home: Path) -> dict[str, str]: ...   # optional
    def live(self, home: Path, probe: ProcessProbe) -> list[LiveSession]: ...  # optional, Cap.LIVE
```

Registry: `load_adapters()` returns built-ins plus entry points in group `agent_track.adapters`. A broken plugin logs a warning and is skipped; it never fails ingest. T3 is a titles-only overlay adapter (no INGEST).
Row types in model.py (Thread, Event, Edge, Parsed) stay. Fields an agent does not record stay None.

## Platform layer (src/agenttrack/platform.py)

`Env(os, home, xdg_data, app_support, appdata, probe, metrics)` holds every OS difference. Nothing else calls `sys.platform`, `/proc` or `Path.home()/".claude"`.
ProcessProbe: LinuxProc (stdlib /proc, current behavior), PsutilProbe (extra `full`), NullProbe. MachineMetrics likewise. Without a probe, status falls back to timestamps and is labelled approximate; Machine view is hidden.
Paths: Linux XDG, macOS ~/Library/Application Support, Windows %APPDATA%. Config: tomllib `config.toml` in the OS config dir, env `AGENT_TRACK_*` overrides. Default DB in the OS data dir, never the repo.

## CLI (agent-track)

doctor [--json] | serve | ingest | install-service (systemd user unit / launchd plist, templated for the current user; Windows prints manual instructions) | skill install | query | adapter check <path>.
`serve` binds 127.0.0.1; a non-loopback host needs `--allow-remote` and prints a warning that data includes prompt text.
No MCP server. The CLI is the tool.

## Bundled skills (src/agenttrack/skill/)

`agent-track-setup`: sequences `doctor --json`, `skill install`, `install-service`, open URL.
`agent-track-adapter-author`: how an agent writes and validates a new adapter against fixtures with `adapter check`.
Installed into ~/.claude/skills, ~/.codex/skills, ~/.agents/skills (whichever dirs exist or are requested).

## Non-goals v0.1
Multi-machine aggregation, push/hook collector, Windows service installer, adapters for agents with no local data to verify against.
