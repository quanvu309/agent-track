# Setup for AI agents

You were told "install agent-track". Do exactly this. Do not edit the project; install it as a user.

1. Diagnose. Run `uvx --from agent-track-cli agent-track doctor --json` and read the output. If `uvx` is missing, use `pipx run --spec agent-track-cli agent-track doctor --json` (do not use `pip install --user`, it fails under PEP 668).
2. Read the JSON. The core field is the list of adapter detections, each with:
   - `id`: the agent (`claude`, `codex`, `grok`, `t3`), with `display_name` and `capabilities`.
   - `detected`: true when its data directory exists.
   - `home`: its session directory, or null. Null means that agent is not installed, which is fine.
   - `schema_ok`: false means files were found but the format is unrecognized. Report the `note` and continue.
   - `note`: a human-readable reason or hint, or null.
   Doctor also reports `platform` (`os`, `probe`, `metrics`, `live_status`, `machine_view`, `status_label`), `config` (`path`, `exists`, `error`, `db`, `host`, `data_dir`) and `port` (`port`, `free`). If `platform.live_status` is false on macOS or Windows, install `agent-track-cli[full]` for process and machine data. Without it, status is approximate and the Machine view is hidden. A non-null `config.error` or `port.free: false` is a problem to report. Python 3.11 or newer is required.
3. Install the CLI persistently: `pipx install agent-track-cli` (or `pipx install "agent-track-cli[full]"`). Then run `agent-track skill install` to copy the bundled skills into the agent skill directories that exist (`--dest DIR` picks another, `--force` overwrites changed files).
4. Run `agent-track install-service` (add `--dry-run` to preview, `--port N` to change the port). On Linux it writes a systemd user unit, on macOS a launchd plist, and prints the command that enables it. Run that command, or pass `--enable` to have agent-track run it. On Windows it prints manual steps; follow them. `--uninstall` removes the service file.
5. Report to the user: the URL (`http://127.0.0.1:3874`), which agents were detected, and any `schema_ok: false` or approximate-status warnings.

Privacy: the dashboard stores prompt text. Keep the default loopback bind. Never pass `--allow-remote` unless the user asks.

If the user's agent tool is not supported, load the `agent-track-adapter-author` skill and write an adapter.
