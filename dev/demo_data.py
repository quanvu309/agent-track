#!/usr/bin/env python3
"""Write synthetic Claude Code, Codex and Grok session files into a scratch HOME for demos and screenshots.

Usage: python3 dev/demo_data.py OUT_DIR [--seed N] [--days N] [--no-live]

Then run the dashboard against it:
    HOME=OUT_DIR PYTHONPATH=src python3 -m agenttrack --db OUT_DIR/db.sqlite serve --port 3999

The output is deterministic for a given seed and --now. Everything is invented. This script never reads the real home.
With live sessions on (Linux only) it starts short-lived placeholder processes so the live probe sees real pids.
They exit by themselves after --live-seconds. Their pids are listed in OUT_DIR/live-pids.txt.
"""

import argparse
import json
import os
import random
import shutil
import sqlite3
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

PROJECTS = {
    "acme-web": [
        ("Fix flaky checkout test", "The checkout e2e test fails about one run in five. Find the race and fix it."),
        ("Add dark mode toggle", "Add a dark mode toggle to the settings page and persist the choice."),
        ("Migrate forms to the new validation lib", "Move the signup and profile forms to the shared validation helpers."),
        ("Speed up product list rendering", "The product list janks on large catalogs. Profile it and virtualize the rows."),
        ("Refactor the navbar component", "Split the navbar into smaller components and add tests for the mobile menu."),
    ],
    "billing-api": [
        ("Add idempotency keys to charges", "Charge requests must accept an idempotency key and replay the stored response."),
        ("Fix rounding in proration", "Prorated invoices are off by a cent in some cases. Reproduce and fix."),
        ("Write webhook retry worker", "Failed webhooks should retry with exponential backoff and a dead letter table."),
        ("Document the invoices endpoints", "Generate OpenAPI docs for the invoices routes and add examples."),
        ("Upgrade the database driver", "Upgrade the Postgres driver and fix any breaking changes in the query layer."),
    ],
    "mobile-app": [
        ("Fix crash on cold start", "The app crashes on cold start on older Android devices. Find the cause."),
        ("Add offline mode for the feed", "Cache the feed locally and show it when the network is unavailable."),
        ("Implement pull to refresh", "Add pull to refresh on the home screen with a loading indicator."),
        ("Reduce bundle size", "Find the largest dependencies in the bundle and cut the size by 15 percent."),
    ],
    "data-pipeline": [
        ("Backfill the events table", "Write a backfill job for the events table covering the last 90 days."),
        ("Add schema validation to ingestion", "Reject malformed events at ingestion and report counts per reason."),
        ("Optimize the nightly aggregation", "The nightly aggregation takes two hours. Find the slow stage and speed it up."),
    ],
    "docs-site": [
        ("Fix broken links", "Crawl the docs build and fix every broken internal link."),
        ("Add a search page", "Add client side search over the docs with keyboard shortcuts."),
        ("Write the getting started guide", "Write a getting started guide with a runnable example for each step."),
    ],
}
FOLLOW_UPS = [
    "Looks good. Now add tests for the edge cases.",
    "Can you also update the docs for this change?",
    "Run the full test suite and fix anything that broke.",
    "Why did that fail? Look at the error and try again.",
    "Make the naming more consistent with the rest of the codebase.",
    "Great. Open a summary of what changed.",
    "Handle the empty state as well.",
    "Please lint and format the changed files.",
]
CLAUDE_TOOLS = ["Read", "Read", "Read", "Edit", "Edit", "Bash", "Bash", "Grep", "Glob", "Write", "TodoWrite"]
CODEX_TOOLS = ["shell", "shell", "shell", "apply_patch", "apply_patch", "update_plan"]
GROK_TOOLS = ["read_file", "read_file", "edit_file", "bash", "bash", "grep", "list_dir"]
SUB_DESCRIPTIONS = ["Survey the test setup", "Find all callers of the helper", "Review the diff for regressions", "Search the codebase for similar patterns"]
CLAUDE_MODELS = [("claude-opus-4-5", 0.35), ("claude-sonnet-4-5", 0.65)]
CODEX_MODELS = [("gpt-5.5", 0.6), ("gpt-5.5-codex", 0.4)]
GROK_MODELS = [("grok-4", 0.5), ("grok-code-fast-1", 0.5)]
AGENT_MIX = [("claude", 0.6), ("codex", 0.25), ("grok", 0.15)]
HOME_DIR = "/home/demo"


def stamp(dt: datetime) -> str:
    return f"{dt:%Y-%m-%dT%H:%M:%S}.{dt.microsecond // 1000:03d}Z"


def stamp_ns(dt: datetime) -> str:
    return f"{dt:%Y-%m-%dT%H:%M:%S}.{dt.microsecond:06d}000Z"


@dataclass
class Step:
    tool: str
    t_call: float
    t_done: float | None
    failed: bool
    ctx: int
    created: int
    out: int
    sub: list["Step"] = field(default_factory=list)
    description: str = ""


@dataclass
class Turn:
    t_prompt: float
    prompt: str
    steps: list[Step]
    t_final: float | None
    ctx: int
    out: int


@dataclass
class Plan:
    project: str
    cwd: str
    title: str
    model: str
    turns: list[Turn]
    duration: float
    sub_model: str


class Gen:
    def __init__(self, out: Path, seed: int, now: datetime):
        self.out, self.rng, self.now = out, random.Random(seed), now
        self.counters = {"claude": 0, "codex": 0, "grok": 0}

    def pick(self, weighted):
        r, acc = self.rng.random(), 0.0
        for item, w in weighted:
            acc += w
            if r < acc:
                return item
        return weighted[-1][0]

    def uid(self) -> str:
        h = f"{self.rng.getrandbits(128):032x}"
        return f"{h[:8]}-{h[8:12]}-4{h[13:16]}-a{h[17:20]}-{h[20:]}"

    def plan(self, agent: str, models, dangling: bool = False, turns: int | None = None) -> Plan:
        rng = self.rng
        project = rng.choice(list(PROJECTS))
        title, first = rng.choice(PROJECTS[project])
        model = self.pick(models)
        tools = {"claude": CLAUDE_TOOLS, "codex": CODEX_TOOLS, "grok": GROK_TOOLS}[agent]
        n_turns = turns or rng.choice([1, 2, 2, 3, 3, 4, 5])
        t, ctx, out_turns = 0.0, rng.randint(9000, 18000), []
        for i in range(n_turns):
            t_prompt = t
            prompt = first if i == 0 else rng.choice(FOLLOW_UPS)
            t += rng.uniform(3, 9)
            steps = []
            for _ in range(rng.randint(2, 9)):
                tool = rng.choice(tools)
                if agent == "claude" and rng.random() < 0.07:
                    tool = "Task"
                dur = rng.uniform(0.3, 6) if tool != "Bash" else rng.uniform(1, 45)
                step = Step(tool, t, t + dur, rng.random() < 0.08, ctx, rng.randint(300, 3500), rng.randint(60, 700))
                if tool == "Task":
                    step.description = rng.choice(SUB_DESCRIPTIONS)
                    sub_t = t + 2
                    for _ in range(rng.randint(3, 6)):
                        d = rng.uniform(0.5, 5)
                        step.sub.append(Step(rng.choice(["Read", "Grep", "Glob", "Read"]), sub_t, sub_t + d, rng.random() < 0.05, rng.randint(4000, 30000), rng.randint(200, 1500), rng.randint(40, 300)))
                        sub_t += d + rng.uniform(2, 7)
                    step.t_done = sub_t + 2
                    dur = step.t_done - t
                steps.append(step)
                ctx += step.created
                t += dur + rng.uniform(2, 11)
            t_final = t
            out_turns.append(Turn(t_prompt, prompt, steps, t_final, ctx, rng.randint(250, 1800)))
            t += rng.uniform(15, 400)
        if dangling:
            last = out_turns[-1]
            last.steps[-1].t_done = None
            last.t_final = None
            t = last.steps[-1].t_call
        else:
            t = out_turns[-1].t_final + 2
        sub_model = "claude-haiku-4-5"
        return Plan(project, f"{HOME_DIR}/{project}", title, model, out_turns, t, sub_model)

    def start_times(self, days: int):
        rng, out = self.rng, []
        for d in range(days):
            day = (self.now - timedelta(days=d)).replace(hour=0, minute=0, second=0, microsecond=0)
            weekend = day.weekday() >= 5
            for _ in range(rng.randint(1, 3) if weekend else rng.randint(5, 9)):
                if d == 0:
                    start = self.now - timedelta(hours=rng.uniform(0.9, 9))
                else:
                    hour = min(23.5, max(6.5, rng.gauss(14, 3.5)))
                    start = day + timedelta(hours=hour)
                out.append(start)
        return sorted(out)

    # Claude Code

    def write_claude(self, plan: Plan, start: datetime, live: str | None = None, sub_running: bool = False):
        rng = self.rng
        sid = self.uid()
        slug = plan.cwd.replace("/", "-")
        proj_dir = self.out / ".claude" / "projects" / slug
        proj_dir.mkdir(parents=True, exist_ok=True)
        lines = [{"type": "ai-title", "aiTitle": plan.title, "sessionId": sid}]
        base = {"cwd": plan.cwd, "sessionId": sid, "version": "2.1.0"}

        def at(off):
            return stamp(start + timedelta(seconds=off))

        def assistant(off, model, content, usage, reason, extra=None):
            msg = {"id": "msg_" + self.uid()[:24], "model": model, "role": "assistant", "content": content, "stop_reason": reason, "usage": usage}
            return {"type": "assistant", "message": msg, "timestamp": at(off), **base, **(extra or {})}

        def usage(ctx, created, out):
            return {"input_tokens": rng.randint(1, 12), "cache_creation_input_tokens": created, "cache_read_input_tokens": ctx, "output_tokens": out}

        def result(off, tool_id, failed, extra=None):
            content = "Error: command exited with status 1" if failed else "ok"
            block = {"type": "tool_result", "tool_use_id": tool_id, "content": content}
            if failed:
                block["is_error"] = True
            return {"type": "user", "message": {"role": "user", "content": [block]}, "timestamp": at(off), **base, **(extra or {})}

        sub_files = []
        for turn in plan.turns:
            lines.append({"type": "user", "message": {"role": "user", "content": turn.prompt}, "timestamp": at(turn.t_prompt), **base})
            for step in turn.steps:
                tid = "toolu_" + self.uid()[:20]
                lines.append(assistant(step.t_call, plan.model, [{"type": "tool_use", "id": tid, "name": step.tool, "input": {}}], usage(step.ctx, step.created, step.out), "tool_use"))
                if step.sub:
                    aid = self.uid()[:17].replace("-", "")
                    sub_lines = [{"type": "user", "isSidechain": True, "agentId": aid, "message": {"role": "user", "content": step.description}, "timestamp": at(step.t_call + 1), **base}]
                    for s in step.sub:
                        sub_tid = "toolu_" + self.uid()[:20]
                        sub_lines.append({**assistant(s.t_call, plan.sub_model, [{"type": "tool_use", "id": sub_tid, "name": s.tool, "input": {}}], usage(s.ctx, s.created, s.out), "tool_use"), "isSidechain": True, "agentId": aid})
                        sub_lines.append({**result(s.t_done, sub_tid, s.failed), "isSidechain": True, "agentId": aid})
                    running = sub_running and step is turn.steps[-1] and step.t_done is None
                    if not running:
                        sub_lines.append({**assistant(step.t_done - 1, plan.sub_model, [{"type": "text", "text": "Done."}], usage(9000, 200, 120), "end_turn"), "isSidechain": True, "agentId": aid})
                    sub_files.append((aid, sub_lines, step.description, not running, plan.sub_model))
                if step.t_done is not None:
                    lines.append(result(step.t_done, tid, step.failed))
            if turn.t_final is not None:
                lines.append(assistant(turn.t_final, plan.model, [{"type": "text", "text": "Done. The change is in place and tests pass."}], usage(turn.ctx, rng.randint(300, 2000), turn.out), "end_turn"))
        self.dump(proj_dir / f"{sid}.jsonl", lines)
        for aid, sub_lines, desc, finished, model in sub_files:
            sub_dir = proj_dir / sid / "subagents"
            sub_dir.mkdir(parents=True, exist_ok=True)
            self.dump(sub_dir / f"agent-{aid}.jsonl", sub_lines)
            (sub_dir / f"agent-{aid}.meta.json").write_text(json.dumps({"agentType": "general-purpose", "description": desc, "model": model.split("-")[1], "finished": finished}))
        return sid

    # Codex

    def write_codex(self, plan: Plan, start: datetime, live: str | None = None):
        rng = self.rng
        root = self.uid()
        day_dir = self.out / ".codex" / "sessions" / f"{start:%Y}" / f"{start:%m}" / f"{start:%d}"
        day_dir.mkdir(parents=True, exist_ok=True)
        threads = [(root, root, plan.turns, None)]
        child_turns = None
        for turn in plan.turns[:1]:
            if len(turn.steps) >= 6:
                child_turns = turn
        if child_turns is not None:
            cstart = child_turns.steps[1].t_call + 1
            threads.append((self.uid(), root, [("child", cstart)], root))
        path = None
        for tid, sess, turns, parent in threads:
            ord_ = [0]

            def row(off, kind, payload):
                ord_[0] += 1
                return {"timestamp": stamp(start + timedelta(seconds=off)), "ordinal": ord_[0] - 1, "type": kind, "payload": payload}

            first = turns[0][1] if parent else 0.0
            source = {"subagent": {"thread_spawn": {"parent_thread_id": parent, "depth": 1}}} if parent else "cli"
            meta = {"id": tid, "session_id": sess, "timestamp": stamp(start + timedelta(seconds=first)), "cwd": plan.cwd, "source": source}
            if parent:
                meta["parent_thread_id"] = parent
            lines = [row(first, "session_meta", meta), row(first + 0.1, "turn_context", {"turn_id": "t0", "model": plan.model})]
            if parent:
                lines.append(row(first + 0.2, "event_msg", {"type": "task_started"}))
                t = first + 1
                for i in range(rng.randint(3, 5)):
                    lines.append(row(t, "response_item", {"type": "function_call", "id": f"fc{i}", "name": "shell", "call_id": f"fc{i}", "arguments": "{}"}))
                    lines.append(row(t + 0.5, "response_item", {"type": "function_call_output", "call_id": f"fc{i}", "output": "ok"}))
                    lines.append(row(t + 1, "token_usage_record", {"thread_id": tid, "session_id": sess, "response_id": "r" + self.uid()[:10], "usage": self.codex_usage(rng.randint(8000, 30000))}))
                    t += rng.uniform(2, 6)
                lines.append(row(t, "event_msg", {"type": "task_complete"}))
            else:
                for turn in turns:
                    lines.append(row(turn.t_prompt, "response_item", {"type": "message", "id": "u" + self.uid()[:8], "role": "user", "content": [{"type": "input_text", "text": turn.prompt}]}))
                    lines.append(row(turn.t_prompt + 0.1, "event_msg", {"type": "task_started"}))
                    for k, step in enumerate(turn.steps):
                        cid = "call_" + self.uid()[:12]
                        if step.tool == "apply_patch":
                            lines.append(row(step.t_call, "response_item", {"type": "custom_tool_call", "id": cid, "name": "apply_patch", "call_id": cid, "input": "*** Begin Patch"}))
                            if step.t_done is not None:
                                text = "Script failed: patch did not apply" if step.failed else "Script completed"
                                lines.append(row(step.t_done, "response_item", {"type": "custom_tool_call_output", "call_id": cid, "output": text}))
                        else:
                            lines.append(row(step.t_call, "response_item", {"type": "function_call", "id": cid, "name": step.tool, "call_id": cid, "arguments": "{}"}))
                            if step.t_done is not None:
                                lines.append(row(step.t_done, "response_item", {"type": "function_call_output", "call_id": cid, "output": "ok"}))
                        if step.t_done is not None:
                            lines.append(row(step.t_done + 0.2, "token_usage_record", {"thread_id": tid, "session_id": sess, "response_id": "r" + self.uid()[:10], "usage": self.codex_usage(step.ctx, step.out)}))
                    if turn.t_final is not None:
                        lines.append(row(turn.t_final, "token_usage_record", {"thread_id": tid, "session_id": sess, "response_id": "r" + self.uid()[:10], "usage": self.codex_usage(turn.ctx, turn.out)}))
                        lines.append(row(turn.t_final + 0.5, "event_msg", {"type": "task_complete"}))
            name = f"rollout-{start + timedelta(seconds=first):%Y-%m-%dT%H-%M-%S}-{tid}.jsonl"
            self.dump(day_dir / name, lines)
            if parent is None:
                path = day_dir / name
        self.codex_titles.append((root, plan.title))
        return root, path

    def codex_usage(self, ctx, out=None):
        rng = self.rng
        out = out or rng.randint(80, 900)
        cached = int(ctx * rng.uniform(0.82, 0.96))
        fresh = rng.randint(300, 2500)
        return {"input_tokens": cached + fresh, "cached_input_tokens": cached, "output_tokens": out, "total_tokens": cached + fresh + out}

    # Grok

    def write_grok(self, plan: Plan, start: datetime):
        rng = self.rng
        sid = self.uid()
        cwd_dir = self.out / ".grok" / "sessions" / quote(plan.cwd, safe="")
        sess_dir = cwd_dir / sid
        sess_dir.mkdir(parents=True, exist_ok=True)

        def at(off):
            return start + timedelta(seconds=off)

        summary = {"info": {"id": sid, "cwd": plan.cwd}, "generated_title": plan.title, "created_at": stamp_ns(start), "current_model_id": plan.model, "session_kind": "interactive"}
        (sess_dir / "summary.json").write_text(json.dumps(summary))
        history, events, updates, turns = [], [], [], []
        spawned = None
        for n, turn in enumerate(plan.turns, 1):
            history.append({"timestamp": stamp_ns(at(turn.t_prompt)), "session_id": sid, "prompt": turn.prompt, "is_bash": False})
            for step in turn.steps:
                events.append({"ts": stamp(at(step.t_call)), "type": "tool_started", "tool_name": step.tool})
                if step.t_done is not None:
                    events.append({"ts": stamp(at(step.t_done)), "type": "tool_completed", "tool_name": step.tool, "duration_ms": int((step.t_done - step.t_call) * 1000), "outcome": "error" if step.failed else "success"})
                if spawned is None and step.tool == "grep" and len(plan.turns) > 1:
                    spawned = (self.uid(), step.t_call)
            ctx = turn.ctx
            cached = int(ctx * rng.uniform(0.8, 0.94))
            inp, out = cached + rng.randint(500, 4000), turn.out
            usage = {"turnNumber": n, "endedAt": stamp_ns(at(turn.t_final)).replace("Z", "+00:00"), "inputTokens": inp, "outputTokens": out, "cachedReadTokens": cached, "primaryModelId": plan.model, "modelUsage": {plan.model: {"inputTokens": inp, "outputTokens": out, "cachedReadTokens": cached}}}
            turns.append(usage)
        (sess_dir / "usage.json").write_text(json.dumps({"sessionId": sid, "updatedAt": stamp_ns(at(plan.duration)).replace("Z", "+00:00"), "turns": turns}))
        if spawned:
            child, off = spawned
            updates.append({"timestamp": int(at(off).timestamp()), "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "subagent_spawned", "child_session_id": child, "parent_session_id": sid}, "_meta": {"agentTimestampMs": int(at(off).timestamp() * 1000)}}})
            child_dir = cwd_dir / child
            child_dir.mkdir(exist_ok=True)
            (child_dir / "summary.json").write_text(json.dumps({"info": {"id": child, "cwd": plan.cwd}, "created_at": stamp_ns(at(off)), "current_model_id": plan.model, "session_kind": "subagent"}))
            self.dump(child_dir / "events.jsonl", [{"ts": stamp(at(off + 1 + i)), "type": "tool_started", "tool_name": "read_file"} for i in range(3)])
        self.dump(sess_dir / "events.jsonl", events)
        self.dump(sess_dir / "updates.jsonl", updates)
        hist_path = cwd_dir / "prompt_history.jsonl"
        with open(hist_path, "a", encoding="utf-8") as fh:
            for d in history:
                fh.write(json.dumps(d) + "\n")

    @staticmethod
    def dump(path: Path, rows):
        with open(path, "w", encoding="utf-8") as fh:
            for r in rows:
                fh.write(json.dumps(r, separators=(",", ":")) + "\n")


def proc_start(pid: int) -> str:
    text = Path(f"/proc/{pid}/stat").read_text()
    return text[text.rindex(")") + 1:].split()[19]


def spawn(argv) -> int:
    return subprocess.Popen(argv, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).pid


def generate(out: Path, seed: int = 7, days: int = 14, now: datetime | None = None, live: bool = True, live_seconds: int = 7200):
    now = (now or datetime.now(timezone.utc)).replace(microsecond=0)
    out.mkdir(parents=True, exist_ok=True)
    gen = Gen(out, seed, now)
    gen.codex_titles = []
    for start in gen.start_times(days):
        agent = gen.pick(AGENT_MIX)
        models = {"claude": CLAUDE_MODELS, "codex": CODEX_MODELS, "grok": GROK_MODELS}[agent]
        plan = gen.plan(agent, models)
        if start + timedelta(seconds=plan.duration) > now - timedelta(minutes=30):
            continue
        {"claude": lambda: gen.write_claude(plan, start), "codex": lambda: gen.write_codex(plan, start), "grok": lambda: gen.write_grok(plan, start)}[agent]()

    pids = []
    if live and sys.platform.startswith("linux"):
        sessions_dir = out / ".claude" / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)
        sleeper = shutil.which("sleep") or "/bin/sleep"
        for dangling, subs, age_s, project_turns in ((True, True, 12, 4), (False, False, 150, 3), (True, False, 25, 3), (False, False, 420, 2)):
            plan = gen.plan("claude", CLAUDE_MODELS, dangling=dangling, turns=project_turns)
            if subs and not any(s.tool == "Task" for s in plan.turns[-1].steps):
                last = plan.turns[-1].steps[-1]
                last.tool, last.description, last.sub = "Task", "Review the diff for regressions", [Step("Read", last.t_call + 2, last.t_call + 5, False, 12000, 400, 90)]
            start = now - timedelta(seconds=age_s + plan.duration)
            sid = gen.write_claude(plan, start, sub_running=subs)
            pid = spawn([sleeper, str(live_seconds)])
            pids.append(pid)
            (sessions_dir / f"{pid}.json").write_text(json.dumps({"pid": pid, "sessionId": sid, "procStart": proc_start(pid), "startedAt": int(start.timestamp() * 1000), "cwd": plan.cwd, "kind": "interactive"}))
        plan = gen.plan("codex", CODEX_MODELS, dangling=True, turns=3)
        plan.turns[-1].steps[-1].tool = "shell"
        start = now - timedelta(seconds=20 + plan.duration)
        _, rollout = gen.write_codex(plan, start)
        # task_started was the last decisive record because the dangling turn has no task_complete
        bin_dir = out / "bin"
        bin_dir.mkdir(exist_ok=True)
        fake = bin_dir / "codex"
        # a script's process name is its file name, and the shell keeps the rollout open the way Codex does
        fake.write_text('#!/bin/sh\nexec 3<"$1"\nsleep "$2"\n')
        fake.chmod(0o755)
        pids.append(spawn([str(fake), str(rollout), str(live_seconds)]))
        (out / "live-pids.txt").write_text("\n".join(map(str, pids)) + "\n")

    if gen.codex_titles:
        codex_home = out / ".codex"
        conn = sqlite3.connect(codex_home / "state_5.sqlite")
        conn.execute("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT)")
        conn.executemany("INSERT OR REPLACE INTO threads VALUES (?, ?)", gen.codex_titles)
        conn.commit()
        conn.close()
    return pids


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("out", type=Path, help="scratch HOME to write into")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--now", help="ISO UTC time to treat as now (default: the real now)")
    ap.add_argument("--no-live", action="store_true", help="skip the live sessions and their placeholder processes")
    ap.add_argument("--live-seconds", type=int, default=7200, help="how long the placeholder processes stay alive")
    args = ap.parse_args()
    if Path(args.out).resolve() == Path.home().resolve():
        sys.exit("refusing to write into the real home")
    now = datetime.fromisoformat(args.now.replace("Z", "+00:00")).astimezone(timezone.utc) if args.now else None
    pids = generate(args.out, args.seed, args.days, now, not args.no_live, args.live_seconds)
    print(f"wrote demo data under {args.out}; live pids: {pids or 'none'}")


if __name__ == "__main__":
    main()
