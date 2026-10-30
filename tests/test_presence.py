import json
import os
import shutil
import tempfile
import time
import unittest
from pathlib import Path

from agenttrack import presence
from agenttrack.adapters import claude, load_adapters
from agenttrack.platform import LinuxProc

SID = "764a74ac-031e-4edd-bb35-81d51a0db6f2"
CODEX_ID = "01a162d9-0000-7000-8000-000000000001"
CHILD_ID = "01a162d9-0000-7000-8000-000000000002"


def line(**record) -> str:
    return json.dumps(record) + "\n"


def stat_text(pid: int, start: int) -> str:
    # Fields 1..21 before starttime; the comm holds a space and a parenthesis to prove the split is after the last ")".
    return f"{pid} (cl (au)de) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 {start} 0 0\n"


class PresenceCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.claude, self.proc = self.tmp / "claude", self.tmp / "proc"
        (self.claude / "sessions").mkdir(parents=True)
        (self.claude / "projects" / "slug").mkdir(parents=True)
        self.proc.mkdir()
        self.homes = {"claude": self.claude, "codex": self.tmp / "codex"}

    def process(self, pid: int, start: int, comm: str = "claude"):
        (self.proc / str(pid)).mkdir()
        (self.proc / str(pid) / "stat").write_text(stat_text(pid, start))
        (self.proc / str(pid) / "comm").write_text(comm + "\n")

    def register(self, pid: int, start: int, session_id: str = SID, alive_start: int | None = None):
        (self.claude / "sessions" / f"{pid}.json").write_text(
            json.dumps({"pid": pid, "sessionId": session_id, "startedAt": 1792742970800 + pid, "procStart": str(start)}))
        if alive_start is not None:
            self.process(pid, alive_start)

    def transcript(self, *records: str, session_id: str = SID) -> Path:
        path = self.claude / "projects" / "slug" / f"{session_id}.jsonl"
        path.write_text("".join(records))
        return path

    def scan(self):
        return presence.scan(load_adapters(), self.homes, LinuxProc(self.proc))


class ClaudeTest(PresenceCase):
    def test_a_reused_pid_created_after_the_session_began_is_not_alive_without_exact_start_times(self):
        class Approximate(LinuxProc):
            exact_start_time = False

            def start_time(self, pid):
                return str(created[pid])

        created = {10: 1792742970, 11: 1792742999}
        self.register(10, 500, alive_start=500)
        self.register(11, 501, session_id="other-session", alive_start=501)
        scan = presence.scan(load_adapters(), self.homes, Approximate(self.proc))
        alive = presence.apply([{"session_id": SID, "harness": "claude"}, {"session_id": "other-session", "harness": "claude"}], scan)
        self.assertEqual(alive[1]["state"], "ended")
        self.assertNotEqual(alive[0]["state"], "ended")

    def test_api_request_is_working_with_pid_and_timestamp(self):
        self.register(10, 500, alive_start=500)
        self.transcript(line(type="assistant", timestamp="2026-10-23T09:44:42.000Z", message={"stop_reason": "end_turn"}),
                        line(type="api-request", timestamp="2026-10-23T09:49:30.123Z"),
                        line(type="attachment", timestamp="2026-10-23T09:49:31.000Z"))
        p = self.scan()
        self.assertEqual(p.sessions[SID], {"state": "working", "since": "2026-10-23T09:49:30.123Z", "pid": 10})
        self.assertEqual(p.covered, frozenset({"claude", "codex"}))

    def test_end_turn_is_idle_since_that_record(self):
        self.register(10, 500, alive_start=500)
        self.transcript(line(type="user", timestamp="2026-10-23T09:40:00.000Z", message={"content": "hi"}),
                        line(type="assistant", timestamp="2026-10-23T09:44:42.000Z", message={"stop_reason": "end_turn"}),
                        line(type="user", isMeta=True, timestamp="2026-10-23T09:45:00.000Z"),
                        line(type="last-prompt", lastPrompt="x"),
                        line(type="api-request-blob", message={"role": "system"}))
        self.assertEqual(self.scan().sessions[SID], {"state": "idle", "since": "2026-10-23T09:44:42.000Z", "pid": 10})

    def test_tool_use_and_streaming_assistant_records_are_working(self):
        self.register(10, 500, alive_start=500)
        for reason in (None, "tool_use", "max_tokens"):
            self.transcript(line(type="assistant", timestamp="2026-10-23T09:44:42.000Z", message={"stop_reason": reason}))
            self.assertEqual(self.scan().sessions[SID]["state"], "working", reason)

    def test_user_prompt_is_working_and_interrupt_is_idle(self):
        self.register(10, 500, alive_start=500)
        self.transcript(line(type="user", timestamp="2026-10-23T09:49:00.000Z", message={"content": "do it"}))
        self.assertEqual(self.scan().sessions[SID]["state"], "working")
        self.transcript(line(type="user", timestamp="2026-10-23T09:49:00.000Z",
                             message={"content": [{"type": "text", "text": "[Request interrupted by user]"}]}))
        self.assertEqual(self.scan().sessions[SID]["state"], "idle")

    def test_no_decisive_record_is_idle_since_none(self):
        self.register(10, 500, alive_start=500)
        self.transcript(line(type="ai-title", aiTitle="t"))
        self.assertEqual(self.scan().sessions[SID], {"state": "idle", "since": None, "pid": 10})

    def test_stale_registry_is_not_alive_and_apply_marks_it_ended(self):
        self.register(10, 500, alive_start=777)
        self.register(11, 600)  # no /proc entry at all
        self.transcript(line(type="api-request", timestamp="2026-10-23T09:49:30.123Z"))
        p = self.scan()
        self.assertNotIn(SID, p.sessions)
        self.assertIn("claude", p.covered)
        rows = presence.apply([{"session_id": SID, "harness": "claude"}], p)
        self.assertEqual((rows[0]["state"], rows[0]["state_since"], rows[0]["pid"]), ("ended", None, None))

    def test_resumed_session_is_open_when_any_registry_file_is_alive(self):
        self.register(10, 500, alive_start=777)
        self.register(12, 900, alive_start=900)
        self.transcript(line(type="api-request", timestamp="2026-10-23T09:49:30.123Z"))
        self.assertEqual(self.scan().sessions[SID]["pid"], 12)

    def test_no_registry_means_claude_is_not_covered(self):
        (self.claude / "sessions" / "notes.txt").write_text("x")
        p = self.scan()
        self.assertNotIn("claude", p.covered)
        rows = presence.apply([{"session_id": SID, "harness": "claude"}], p)
        self.assertEqual((rows[0]["state"], rows[0]["pid"]), (None, None))

    def test_missing_claude_home_never_raises(self):
        shutil.rmtree(self.claude)
        self.assertNotIn("claude", self.scan().covered)

    def test_bad_registry_file_is_skipped(self):
        (self.claude / "sessions" / "bad.json").write_text("{nope")
        self.register(10, 500, alive_start=500)
        self.transcript(line(type="api-request", timestamp="2026-10-23T09:49:30.123Z"))
        self.assertEqual(self.scan().sessions[SID]["state"], "working")

    def test_decisive_record_found_across_a_200_kib_line(self):
        self.register(10, 500, alive_start=500)
        blob = line(type="api-request-blob", sessionId=SID, message={"content": "x" * 200 * 1024})
        self.transcript(line(type="assistant", timestamp="2026-10-23T09:44:42.000Z", message={"stop_reason": "end_turn"}),
                        blob, line(type="queue-operation"))
        self.assertGreater(len(blob), 200 * 1024)
        self.assertEqual(self.scan().sessions[SID], {"state": "idle", "since": "2026-10-23T09:44:42.000Z", "pid": 10})

    def test_subagent_meta_finished_is_ended_or_judged_by_transcript(self):
        self.register(10, 500, alive_start=500)
        self.transcript(line(type="assistant", timestamp="2026-10-23T09:44:42.000Z", message={"stop_reason": "end_turn"}))
        sub = self.claude / "projects" / "slug" / SID / "subagents"
        sub.mkdir(parents=True)
        (sub / "agent-aaa.meta.json").write_text(json.dumps({"finished": True}))
        (sub / "agent-bbb.meta.json").write_text(json.dumps({}))
        (sub / "agent-bbb.jsonl").write_text(line(type="api-request", timestamp="2026-10-23T09:50:00.000Z"))
        (sub / "agent-ccc.meta.json").write_text("{broken")
        p = self.scan()
        self.assertEqual(p.threads, {"aaa": "ended", "bbb": "working"})

    def subagent(self, name: str, *records: str, mtime: float | None = None, meta: dict | None = None) -> Path:
        sub = self.claude / "projects" / "slug" / SID / "subagents"
        sub.mkdir(parents=True, exist_ok=True)
        (sub / f"agent-{name}.meta.json").write_text(json.dumps(meta or {}))
        if not records:
            return sub / f"agent-{name}.jsonl"
        path = sub / f"agent-{name}.jsonl"
        path.write_text("".join(records))
        if mtime is not None:
            os.utime(path, (mtime, mtime))
        return path

    def idle_session(self):
        self.register(10, 500, alive_start=500)
        self.transcript(line(type="assistant", timestamp="2026-10-23T09:44:42.000Z", message={"stop_reason": "end_turn"}))

    def test_busy_subagent_with_fresh_transcript_makes_idle_session_working(self):
        self.idle_session()
        self.subagent("aaa", line(type="api-request", timestamp="2026-10-23T10:00:00.000Z"))
        self.subagent("bbb", line(type="api-request", timestamp="2026-10-23T10:05:00.000Z"))
        p = self.scan()
        self.assertEqual(p.threads, {"aaa": "working", "bbb": "working"})
        self.assertEqual(p.sessions[SID], {"state": "working", "since": "2026-10-23T10:05:00.000Z", "pid": 10})

    def test_subagent_older_than_process_start_is_ended(self):
        self.idle_session()
        started = (1792742970800 + 10) / 1000
        self.subagent("aaa", line(type="api-request", timestamp="2026-10-23T08:24:00.000Z"), mtime=started - 60)
        p = self.scan()
        self.assertEqual(p.threads, {"aaa": "ended"})
        self.assertEqual(p.sessions[SID]["state"], "idle")

    def test_busy_subagent_silent_for_over_twenty_minutes_is_ended(self):
        self.idle_session()
        self.subagent("aaa", line(type="api-request", timestamp="2026-10-23T10:00:00.000Z"),
                      mtime=time.time() - claude.SUBAGENT_STALE_S - 60)
        p = self.scan()
        self.assertEqual(p.threads, {"aaa": "ended"})
        self.assertEqual(p.sessions[SID]["state"], "idle")

    def test_subagent_that_ended_its_turn_is_ended(self):
        self.idle_session()
        self.subagent("aaa", line(type="api-request", timestamp="2026-10-23T10:00:00.000Z"),
                      line(type="assistant", timestamp="2026-10-23T10:01:00.000Z", message={"stop_reason": "end_turn"}))
        self.subagent("bbb", meta={"finished": False})  # no transcript at all
        p = self.scan()
        self.assertEqual(p.threads, {"aaa": "ended", "bbb": "ended"})
        self.assertEqual(p.sessions[SID]["state"], "idle")

    def test_working_session_keeps_its_own_since(self):
        self.register(10, 500, alive_start=500)
        self.transcript(line(type="api-request", timestamp="2026-10-23T09:49:30.000Z"))
        self.subagent("aaa", line(type="api-request", timestamp="2026-10-23T10:05:00.000Z"))
        self.assertEqual(self.scan().sessions[SID]["since"], "2026-10-23T09:49:30.000Z")


class CodexTest(PresenceCase):
    def rollout(self, *records: dict, thread_id: str = CODEX_ID) -> Path:
        path = self.tmp / "codex" / "sessions" / "2026" / "10" / "23" / f"rollout-2026-10-22T16-03-14-{thread_id}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps({"timestamp": r.pop("ts"), "ordinal": i, **r}) + "\n" for i, r in enumerate(records)))
        return path

    def hold(self, pid: int, path: Path, comm: str = "codex"):
        self.process(pid, 1, comm)
        fd = self.proc / str(pid) / "fd"
        fd.mkdir()
        (fd / "0").symlink_to("/dev/null")
        (fd / "3").symlink_to(path)

    def event(self, ts: str, kind: str) -> dict:
        return {"ts": ts, "type": "event_msg", "payload": {"type": kind}}

    def test_open_rollout_with_task_started_is_working(self):
        path = self.rollout(self.event("2026-10-23T09:00:00.000Z", "task_complete"), self.event("2026-10-23T09:40:00.000Z", "task_started"),
                            {"ts": "2026-10-23T09:40:01.000Z", "type": "token_usage_record", "payload": {"thread_id": CODEX_ID}})
        self.hold(77, path)
        p = self.scan()
        self.assertEqual(p.sessions[CODEX_ID], {"state": "working", "since": "2026-10-23T09:40:00.000Z", "pid": 77})
        self.assertEqual(p.threads[CODEX_ID], "working")
        self.assertIn("codex", p.covered)

    def test_open_rollout_with_task_complete_is_idle(self):
        path = self.rollout(self.event("2026-10-23T09:00:00.000Z", "task_started"), self.event("2026-10-23T09:41:09.000Z", "task_complete"))
        self.hold(77, path, comm="codex-app-server")
        self.assertEqual(self.scan().sessions[CODEX_ID], {"state": "idle", "since": "2026-10-23T09:41:09.000Z", "pid": 77})

    def test_user_message_is_working_and_aborted_turn_is_idle(self):
        path = self.rollout({"ts": "2026-10-23T09:42:00.000Z", "type": "response_item", "payload": {"type": "message", "role": "user"}})
        self.hold(77, path)
        self.assertEqual(self.scan().sessions[CODEX_ID]["state"], "working")
        path = self.rollout(self.event("2026-10-23T09:43:00.000Z", "turn_aborted"))
        self.assertEqual(self.scan().sessions[CODEX_ID]["state"], "idle")

    def test_working_child_thread_makes_idle_parent_working(self):
        parent = self.rollout(self.event("2026-10-23T09:00:00.000Z", "task_started"), self.event("2026-10-23T09:41:09.000Z", "task_complete"))
        meta = {"ts": "2026-10-23T09:42:00.000Z", "type": "session_meta", "payload": {
            "id": CHILD_ID, "source": {"subagent": {"thread_spawn": {"parent_thread_id": CODEX_ID, "depth": 1}}},
            "base_instructions": {"text": "x" * 50000}}}
        child = self.rollout(meta, self.event("2026-10-23T09:42:30.000Z", "task_started"), thread_id=CHILD_ID)
        self.hold(77, parent)
        self.hold(78, child)
        p = self.scan()
        self.assertEqual(p.sessions[CHILD_ID]["state"], "working")
        self.assertEqual(p.sessions[CODEX_ID], {"state": "working", "since": "2026-10-23T09:42:30.000Z", "pid": 77})
        self.assertEqual(p.threads[CODEX_ID], "working")

    def test_idle_child_or_root_thread_leaves_idle_parent_alone(self):
        parent = self.rollout(self.event("2026-10-23T09:41:09.000Z", "task_complete"))
        meta = {"ts": "2026-10-23T09:42:00.000Z", "type": "session_meta", "payload": {
            "source": {"subagent": {"thread_spawn": {"parent_thread_id": CODEX_ID}}}}}
        child = self.rollout(meta, self.event("2026-10-23T09:42:30.000Z", "task_complete"), thread_id=CHILD_ID)
        self.hold(77, parent)
        self.hold(78, child)
        self.assertEqual(self.scan().sessions[CODEX_ID]["state"], "idle")

    def test_rollout_nobody_holds_is_ended_when_codex_is_covered(self):
        self.rollout(self.event("2026-10-23T09:41:09.000Z", "task_complete"))
        self.process(5, 1, comm="bash")
        p = self.scan()
        self.assertNotIn(CODEX_ID, p.sessions)
        self.assertEqual(presence.apply([{"session_id": CODEX_ID, "harness": "codex"}], p)[0]["state"], "ended")

    def test_unreadable_proc_root_means_codex_not_covered(self):
        p = presence.scan(load_adapters(), self.homes, LinuxProc(self.tmp / "no-proc"))
        self.assertEqual(p.covered, frozenset())

    def test_unreadable_fd_dir_and_dangling_link_are_skipped(self):
        self.process(70, 1, "codex")
        self.process(71, 1, "codex")
        (self.proc / "71" / "fd").mkdir()
        (self.proc / "71" / "fd" / "3").symlink_to(self.tmp / "gone" / f"rollout-x-{CODEX_ID}.jsonl")
        p = self.scan()
        self.assertEqual(p.sessions[CODEX_ID]["state"], "idle")  # held but the file is gone: no decisive record
        self.assertEqual(p.sessions[CODEX_ID]["pid"], 71)


class ApplyTest(unittest.TestCase):
    def test_fallbacks_for_rows_and_thread_rows(self):
        p = presence.Presence(
            {"S": {"state": "idle", "since": "2026-10-23T09:44:42.000Z", "pid": 9}, "W": {"state": "working", "since": None, "pid": 4}},
            {"sub1": "working"}, frozenset({"claude"}))
        idle = {"session_id": "S", "harness": "claude", "thread_rows": [{"thread_id": "S"}, {"thread_id": "sub1"}, {"thread_id": "sub2"}]}
        busy = {"session_id": "W", "harness": "claude", "thread_rows": [{"thread_id": "W"}, {"thread_id": "sub9"}]}
        gone = {"session_id": "X", "harness": "claude", "thread_rows": [{"thread_id": "X"}, {"thread_id": "y"}]}
        grok = {"session_id": "G", "harness": "grok", "thread_rows": [{"thread_id": "G"}, {"thread_id": "g2"}]}
        plain = {"session_id": "S", "harness": "claude"}
        rows = presence.apply([idle, busy, gone, grok, plain], p)
        self.assertEqual((idle["state"], idle["state_since"], idle["pid"]), ("idle", "2026-10-23T09:44:42.000Z", 9))
        self.assertEqual([t["state"] for t in idle["thread_rows"]], ["idle", "working", "ended"])
        self.assertEqual([t["state"] for t in busy["thread_rows"]], ["working", None])
        self.assertEqual((gone["state"], gone["pid"]), ("ended", None))
        self.assertEqual([t["state"] for t in gone["thread_rows"]], ["ended", "ended"])
        self.assertEqual((grok["state"], grok["state_since"], grok["pid"]), (None, None, None))
        self.assertEqual([t["state"] for t in grok["thread_rows"]], [None, None])
        self.assertEqual(plain["state"], "idle")
        self.assertIs(rows[0], idle)


if __name__ == "__main__":
    unittest.main()
