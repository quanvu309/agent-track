---
name: agent-track-setup
description: Install and configure agent-track, the local dashboard of AI coding agent activity. Use when the user says "install agent-track", "set up agent-track" or asks for a dashboard of their agent sessions.
---

# agent-track setup

Run these in order. Stop and report on any failure.

1. Diagnose: `uvx --from agent-track-cli agent-track doctor --json` (fallback `pipx run --spec agent-track-cli agent-track doctor --json`). Parse the JSON.
2. Read the adapter detections. The list is `adapters`; each has `id`, `detected`, `home`, `schema_ok`, `note`, `capabilities`.
   - `home` null: that agent is not installed. Skip it.
   - `schema_ok` false: files exist but the format is unknown. Tell the user the `note`; do not fail.
3. Check `platform.live_status`. On macOS or Windows when it is false, install the extra: `pipx install "agent-track-cli[full]"`. Otherwise `pipx install agent-track-cli`. Without a probe, status is approximate and the Machine view is hidden.
4. `agent-track skill install` copies the bundled skills into the skill directories that exist.
5. `agent-track install-service --enable` writes a systemd user unit (Linux) or launchd plist (macOS) and starts it. Use `--dry-run` first to preview. On Windows it prints manual steps; relay them.
6. Verify: `agent-track doctor` again, then fetch `http://127.0.0.1:3874/api/summary`.
7. Report: the URL `http://127.0.0.1:3874`, detected agents, and any approximate-status warning.

## Rules

- The data includes prompt text. Keep the loopback bind. Pass `--allow-remote` only if the user explicitly asks, and warn them first.
- If the user's agent tool is not detected or not supported, use the `agent-track-adapter-author` skill.
- Do not edit the agent-track source to get it running.
