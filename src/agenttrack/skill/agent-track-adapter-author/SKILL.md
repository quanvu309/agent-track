---
name: agent-track-adapter-author
description: Write and validate a new agent-track adapter so the dashboard supports another AI coding tool (OpenCode, Pi, Gemini and others). Use when asked to add support for an agent tool that agent-track does not read yet.
---

# Author an agent-track adapter

An adapter is one file in `src/agenttrack/adapters/` (or a package with an entry point in group `agent_track.adapters`). Contract: `docs/design.md`. Copy the closest existing adapter as the template.

## Steps

1. Find the tool's session directory. Check its docs, then look under `~/.<tool>`, the XDG data dir, `~/Library/Application Support` and `%APPDATA%`. Note the file format (JSONL, JSON, SQLite) and what one session looks like.
2. Copy 2 or 3 real sessions into `tests/fixtures/<tool>/`: one short, one with tool calls, one with a sub-agent if the tool has them. Scrub secrets: API keys, tokens, emails, absolute home paths, prompt text you do not want public. Replace with placeholders and keep the structure intact.
3. Implement the `Adapter` fields: `id`, `display_name`, `capabilities`, `process_names`, `homes(env)`, `detect(env)`, `units(home)`, `members(unit)`, `parse(unit)`. Add `titles(home)` and `live(home, probe)` only if the tool records that data.
4. Declare capabilities honestly. Include `Cap.INGEST` only if you parse sessions. Add `TITLES`, `SUBAGENTS`, `TOKENS`, `LIVE` only when the fixtures prove the data exists. A field the tool does not record stays `None`, never a guess or zero.
5. Tolerate unknown lines. Skip unrecognized records and malformed JSON without raising. `detect` returns `schema_ok=False` with a `note` when the format drifts.
6. Resolve paths through `env` (never `Path.home()` or `sys.platform` in the adapter) so it works on Linux, macOS and Windows.
7. Validate: `agent-track adapter check <path-to-adapter-file> --home tests/fixtures/<tool>`. Fix every reported problem.
8. Add tests in `tests/` that parse the fixtures and assert session count, token totals, titles and thread parentage. Run `PYTHONPATH=src python -m unittest discover -s tests`.

## Rules

- Count each session once; avoid double-counting repeated streaming usage lines.
- Never commit unscrubbed data.
- Touch only the new adapter file, its fixtures and its tests.
