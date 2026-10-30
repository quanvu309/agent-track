# agent-track

A local dashboard of AI coding agent activity. It reads the session files of Claude Code, Codex and Grok read-only, normalizes them into one SQLite store, and serves a single page plus a JSON API on `127.0.0.1:3874`. Nothing leaves your machine.

Python 3.11+, standard library only. The optional `full` extra adds `psutil` for process and machine data on macOS and Windows.

## Install

```sh
uvx --from agent-track-cli agent-track serve      # run without installing
pipx install agent-track-cli                      # or install the CLI
pipx install "agent-track-cli[full]"              # adds psutil for macOS and Windows process and machine data
```

The PyPI project is `agent-track-cli`. The commands are `agent-track` and `agenttrack`. Do not run bare `pipx install agent-track` or `uvx agent-track`: that name belongs to an unrelated project.

Then open http://127.0.0.1:3874. Run `agent-track doctor` first if you want to see which agents were found.

Let your own AI agent do it: tell it "install agent-track" and point it at [SETUP.md](SETUP.md) or [llms.txt](llms.txt).

## Supported agents

| Agent | Sessions and tokens | Titles | Sub-agents | Live state |
|---|---|---|---|---|
| Claude Code | yes | yes | yes | yes (Linux, or with `full`) |
| Codex | yes | yes | yes | yes (Linux, or with `full`) |
| Grok | yes | no | yes | no (no evidence source) |
| T3 Code | no | yes (title overlay only) | no | no |

Fields an agent does not record are shown as empty, never guessed.

OpenCode, Pi, Gemini and other tools are not built yet. To add one, an agent can follow the bundled `agent-track-adapter-author` skill (installed by `agent-track skill install`). An adapter is one file under `src/agenttrack/adapters/` that implements the `Adapter` contract in [docs/design.md](docs/design.md). Third parties can ship an adapter as a package that registers an entry point in the group `agent_track.adapters`. Validate it with `agent-track adapter check <path>`.

## Platform support

| OS | Sessions, tokens, titles | Live state, Machine view |
|---|---|---|
| Linux | full | full, from stdlib `/proc` |
| macOS | full | needs `agent-track-cli[full]` (psutil); otherwise approximate |
| Windows | full | needs `agent-track-cli[full]` (psutil); otherwise approximate; no service installer |

Why partial: macOS and Windows have no `/proc`, and the standard library cannot list processes or read memory and CPU. Without a probe, status falls back to file timestamps, is labelled approximate, and the Machine view is hidden. Data paths follow the OS: XDG on Linux, `~/Library/Application Support` on macOS, `%APPDATA%` on Windows. The default database lives in the OS data directory, never in a repository.

## Privacy

The store holds prompt text, tool names and token counts taken from your agents' session files. Treat the database as sensitive. `serve` binds `127.0.0.1` by default. A non-loopback `--host` requires `--allow-remote` and prints a warning that the data includes prompt text. The Machine sampler never reads command lines or environments, and never opens other users' processes.

## CLI

```
agent-track doctor [--json]     report which agents, paths and OS probes were found
agent-track serve               ingest at startup and every 60 s, serve the page and API
agent-track ingest              one incremental ingest, print totals
agent-track install-service     systemd user unit (Linux) or launchd plist (macOS); Windows prints manual steps
                                [--port N] [--dry-run] [--enable] [--uninstall]
agent-track skill install       copy the bundled skills into ~/.claude/skills, ~/.codex/skills, ~/.agents/skills
                                (those that exist) [--dest DIR ...] [--dry-run] [--force]
agent-track query totals        JSON on stdout: per-agent totals and last ingest time
agent-track query recent        JSON on stdout: latest sessions [--limit N]
agent-track adapter check PATH  validate an adapter (.py file or module:Class) [--home FIXTURE_DIR] [--limit N] [--json]
```

`serve` options: `--host` (default `127.0.0.1`), `--port` (default `3874`), `--allow-remote`. `--db PATH` is a top-level flag, so write `agent-track --db PATH serve`. Config is `config.toml` in the OS config directory, and `AGENT_TRACK_*` environment variables override it. Only files whose size or mtime changed are reparsed, so a no-change pass takes well under a second. `POST /api/ingest` (or the Ingest now button) runs a pass on demand. There is no MCP server; the CLI is the tool.

## API

All endpoints are `GET` unless noted. Timestamps are UTC ISO with milliseconds (`2026-10-12T09:31:45.000Z`).

| Endpoint | Returns |
|---|---|
| `/api/summary`, `/api/daily`, `/api/today`, `/api/models` | totals and breakdowns |
| `/api/tools`, `/api/reliability`, `/api/heatmap`, `/api/projects` | tool use, failures, activity, per-project |
| `/api/sessions`, `/api/session/<id>` | session list and detail |
| `/api/live?minutes=N` | recently active sessions with state |
| `/api/burn`, `/api/machine` | token burn and machine view, below |
| `POST /api/ingest` | run an ingest pass now |

### `GET /api/burn`

Token use summed per UTC time bucket and harness. Only buckets with events are returned. Fresh input is `input_tokens - cached_tokens`.

| Param | Values | Default |
|---|---|---|
| `minutes` | 1 to 2880, clamped | 120 |
| `bucket` | bucket width in minutes: 1, 5, 15 or 60 | 5 |
| `harness` | an agent id such as `claude`, `codex`, `grok` | all |

A non-integer `minutes`, another `bucket` or an unknown `harness` is a 400. Buckets align to UTC epoch multiples.

```json
{"bucket_minutes": 5, "since": "2026-10-12T07:30:00.000Z", "until": "2026-10-12T09:34:12.345Z",
 "rows": [{"ts": "2026-10-12T09:30:00.000Z", "harness": "claude", "input_tokens": 1513, "cached_tokens": 509,
           "output_tokens": 72, "prompts": 1, "tool_calls": 2, "responses": 4}]}
```

### `GET /api/machine?minutes=60`

`minutes` is 1 to 10080 (7 days), clamped, default 60. `now` is the sampler's latest snapshot, or `null` before the first sample. `series` averages stored samples into equal UTC buckets of `bucket_seconds` (15 s minimum, at most about 300 points). Memory and disk values are bytes.

```json
{"now": {"ts": "2026-10-12T10:24:18.265Z", "mem_total": 16324280320, "mem_used": 14938083328, "mem_available": 1386196992,
         "swap_total": 8589930496, "swap_used": 8589725696, "cpu_pct": 99.7, "load": [74.67, 83.51, 77.1], "cpus": 8,
         "uptime_s": 347369, "disk_used": 139842347008, "disk_total": 160921083904, "procs": 747,
         "agents": [{"harness": "claude", "mem": 1343008768, "procs": 4}, {"harness": "other", "mem": 12950040576, "procs": 551}],
         "top": [{"pid": 3519080, "comm": "claude", "harness": "claude", "project": "projects/acme", "mem": 431648768}]},
 "bucket_seconds": 15,
 "series": [{"ts": "2026-10-12T10:24:15.000Z", "mem_used": 14938083328, "swap_used": 8589725696, "cpu_pct": 99.7, "load1": 74.67,
             "agents": {"claude": 1343008768, "other": 12950040576}}]}
```

- On Linux, `mem_used` is `MemTotal - MemAvailable`, so reclaimable page cache is not counted. `swap_used` is `SwapTotal - SwapFree`.
- `cpu_pct` is busy time across all CPUs between two consecutive samples. It is `null` on the first sample after start.
- `disk_*` is the filesystem holding the database.
- `procs` counts every process on the machine. `agents` and `top` cover only processes owned by the user running the server.
- `agents` has one entry per agent plus `other`, always in that order. `mem` is private resident memory where the OS reports it (Linux RssAnon), so per-agent numbers do not add up to more than RAM.
- `top` is the 12 largest of those processes by `mem`.
- Any field the machine does not expose is `null`. The server keeps running.

The sampler takes one sample at startup, then one every 15 s on its own thread. A process belongs to an agent when its name equals one of the adapter's `process_names` or starts with that name plus `-`. Child processes such as shells, MCP servers and dev servers count as `other`. Samples older than 7 days are deleted in the same transaction as each insert. The database holds only per-agent totals; the process list is kept in memory. History grows about 1.8 MiB a day.

### `GET /api/live?minutes=N`

Root sessions with at least one event in the last `minutes`, most recent first. Each row has the fields of `/api/sessions` plus `recent_events`, `recent_input`, `recent_output`, `recent_failed`, `recent_tool_calls`, and:

- `state`: `"working"`, `"idle"`, `"ended"` or `null`. Read from the machine, never from the database. `null` means no evidence for that agent, so a client falls back to the age of `last`.
- `state_since`: timestamp of the record that decided `state`, or `null`.
- `pid`: the live process behind the session, or `null`.
- `thread_rows`: every thread of the session ordered by `started_at`, each with its own `state`, token and tool counts.

`/api/sessions` rows and the `session` object of `/api/session/<id>` carry the same `state`, `state_since` and `pid`.

### Counting rules

- **Claude.** One session per top-level transcript `sessionId`. Sub-agent files roll up into it. Tokens come from one line per `message.id`, the one with max `output_tokens`, because streaming repeats usage across lines.
- **Codex.** One session per root `session_id` in the rollout `session_meta`. Tokens are `token_usage_record` lines, unique per `response_id`.
- **Grok.** One session per `summary.json` whose `session_kind` is not `subagent`. Tokens are `usage.json` turns plus later `turn_completed` usage. Root only, because a parent turn already includes its sub-agents.
- **Titles.** The agent's generated title, else for a Claude sub-agent its meta description, else the first prompt, cleaned of command and system markup. When a session was launched from T3 Code, T3's thread title wins for the root thread.
- Input tokens include cache reads and writes. "Cached" is the cache-read subset.

## Development

```sh
git clone https://github.com/quanvu309/agent-track && cd agent-track
PYTHONPATH=src python -m unittest discover -s tests
cd web
pnpm install
pnpm build     # type-checks, then writes ../src/agenttrack/static (gitignored)
pnpm lint
pnpm dev       # hot reload, proxies /api to 127.0.0.1:3874; run `agent-track serve` alongside
```

The frontend is Vite, React, TypeScript, Tailwind and shadcn/ui. The Inter font is bundled, so the page loads nothing from the network. Releases are built by tagging `v*`; the workflow builds the web UI into the wheel and publishes to PyPI.

## License

MIT, see [LICENSE](LICENSE).
