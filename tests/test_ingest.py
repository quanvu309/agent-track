import json
import sqlite3
import shutil
import unittest

from agenttrack import queries, store
from agenttrack.adapters import grok

from helpers import IngestCase

RESPONSES = "SELECT ts, model, input_tokens, cached_tokens, output_tokens, thread_id, session_id FROM events WHERE harness=? AND kind='response' ORDER BY ts, model"


class ClaudeTest(IngestCase):
    def test_streamed_message_keeps_max_output_line_and_dedupes_tool_calls(self):
        self.ingest()
        self.assertEqual(
            self.rows(RESPONSES, "claude"),
            [
                ("2026-10-10T10:00:01.000Z", "claude-x", 502, 400, 50, "s1", "s1"),
                ("2026-10-10T10:00:03.500Z", "claude-x", 1, 0, 7, "ag1", "s1"),
                ("2026-10-10T10:00:05.000Z", "claude-y", 10, 9, 5, "s1", "s1"),
            ],
        )
        self.assertEqual(self.rows("SELECT tool FROM events WHERE harness='claude' AND kind='tool_call' ORDER BY ts"), [("Bash",), ("Read",)])

    def test_only_top_level_real_user_text_counts_as_prompt(self):
        self.ingest()
        self.assertEqual(self.rows("SELECT ts, text FROM events WHERE harness='claude' AND kind='prompt'"), [("2026-10-10T10:00:00.000Z", "hello claude")])

    def test_threads_carry_title_project_and_subagent_parent(self):
        self.ingest()
        self.assertEqual(
            self.rows("SELECT thread_id, session_id, parent_thread_id, project, title FROM threads WHERE harness='claude' ORDER BY thread_id"),
            [("ag1", "s1", "s1", "/tmp/demo", "Investigate the failing build"), ("s1", "s1", None, "/tmp/demo", "Demo title")],
        )

    def test_subagent_without_meta_file_falls_back_to_cleaned_first_prompt(self):
        (self.tmp / "claude/projects/-tmp-demo/s1/subagents/agent-ag1.meta.json").unlink()
        self.ingest()
        self.assertEqual(self.rows("SELECT title FROM threads WHERE thread_id='ag1'"), [("Investigate the thing",)])

    def test_root_without_ai_title_uses_command_args_not_the_xml(self):
        prompt = "<command-message>x-mode</command-message> <command-name>/x-mode</command-name> <command-args>Add a pre-commit hook for large files. Fast.</command-args>"
        line = {"type": "user", "message": {"role": "user", "content": prompt}, "timestamp": "2026-10-10T11:00:00.000Z", "cwd": "/tmp/demo", "sessionId": "s2"}
        (self.tmp / "claude/projects/-tmp-demo/s2.jsonl").write_text(json.dumps(line) + "\n")
        self.ingest()
        self.assertEqual(self.rows("SELECT title FROM threads WHERE thread_id='s2'"), [("Add a pre-commit hook for large files",)])


TOOLS = "SELECT tool, failed, duration_ms FROM events WHERE harness=? AND kind='tool_call' ORDER BY ts, tool"


class ToolOutcomeTest(IngestCase):
    def test_claude_pairs_tool_use_with_tool_result_error_flag_and_latency(self):
        self.ingest()
        self.assertEqual(self.rows(TOOLS, "claude"), [("Bash", 0, 400), ("Read", 1, 900)])

    def test_codex_reads_script_verdict_by_call_id_and_leaves_other_calls_unknown(self):
        self.ingest()
        self.assertEqual(self.rows(TOOLS, "codex"), [("shell", None, None), ("exec", 1, 250)])

    def test_grok_settles_each_start_with_the_next_completion_of_the_same_tool(self):
        self.ingest()
        got = {r[0]: r[1:] for r in self.rows(TOOLS, "grok")}
        self.assertEqual((got["read_file"], got["bash"]), ((0, 250), (1, 1200)))

    def test_old_store_gains_the_columns_and_reparses_everything_once(self):
        self.ingest()
        self.conn.execute("ALTER TABLE events DROP COLUMN failed")
        self.conn.execute("DELETE FROM meta WHERE key='parse_version'")
        self.conn.close()
        self.conn = store.connect(self.tmp / "agenttrack.sqlite")
        self.assertEqual(self.rows("SELECT COUNT(*) FROM files"), [(0,)])
        self.ingest()
        self.assertEqual(self.rows(TOOLS, "claude"), [("Bash", 0, 400), ("Read", 1, 900)])


class CodexTest(IngestCase):
    def test_sums_token_usage_records_and_ignores_cumulative_token_count(self):
        self.ingest()
        self.assertEqual(
            self.rows(RESPONSES, "codex"),
            [
                ("2026-10-10T10:00:02.000Z", "model-x", 1000, 800, 20, "R", "R"),
                ("2026-10-10T10:00:03.000Z", "model-x", 2000, 1500, 30, "R", "R"),
                ("2026-10-10T10:00:05.000Z", "model-y", 500, 0, 5, "R", "R"),
                ("2026-10-10T10:00:12.000Z", "model-z", 100, 50, 10, "C", "R"),
            ],
        )

    def test_prompts_only_from_root_and_skip_wrapper_text(self):
        self.ingest()
        self.assertEqual(self.rows("SELECT thread_id, text FROM events WHERE harness='codex' AND kind='prompt'"), [("R", "do the thing")])

    def test_tool_calls_include_function_and_custom_calls(self):
        self.ingest()
        self.assertEqual(self.rows("SELECT thread_id, tool FROM events WHERE harness='codex' AND kind='tool_call' ORDER BY ts"), [("R", "shell"), ("C", "exec")])

    def test_title_comes_from_state_db_else_first_prompt_else_empty(self):
        self.ingest()
        self.assertEqual(self.rows("SELECT thread_id, parent_thread_id, title FROM threads WHERE harness='codex' ORDER BY thread_id"), [("C", "R", None), ("R", None, "Codex stored title")])

    def test_state_db_title_loses_its_skill_prefix_and_run_on_tail(self):
        state = sqlite3.connect(self.tmp / "codex" / "state_5.sqlite")
        state.execute("UPDATE threads SET title = ? WHERE id = 'R'", ("$poteto-mode move the host from railway to cloudflare; audit it first",))
        state.commit()
        state.close()
        self.ingest()
        self.assertEqual(self.rows("SELECT title FROM threads WHERE thread_id='R'"), [("Move the host from railway to cloudflare",)])


class T3TitleTest(IngestCase):
    def setUp(self):
        super().setUp()
        self.write_t3(
            [
                ("T1", "Redesign Agent Work Dashboard", "2026-10-20"),
                ("T2", "Older name", "2026-10-01"),
                ("T3", "Newest name", "2026-10-22"),
                ("T4", "Apply Acme engine", "2026-10-20"),
            ],
            [("T1", "claudeAgent", "s1"), ("T2", "claudeAgent", "s2"), ("T3", "claudeAgent", "s2"), ("T4", "codex", "R")],
        )

    def titles(self):
        return dict(self.rows("SELECT thread_id, title FROM threads WHERE harness IN ('claude', 'codex')"))

    def test_root_titles_come_from_t3_and_sub_agent_titles_are_unchanged(self):
        self.ingest()
        got = self.titles()
        self.assertEqual((got["s1"], got["R"]), ("Redesign Agent Work Dashboard", "Apply Acme engine"))
        self.assertEqual((got["ag1"], got["C"]), ("Investigate the failing build", None))

    def test_native_id_under_two_t3_threads_takes_the_newest(self):
        line = {"type": "user", "message": {"role": "user", "content": "hello there"}, "timestamp": "2026-10-10T11:00:00.000Z"}
        line |= {"cwd": "/tmp/demo", "sessionId": "s2"}
        (self.tmp / "claude/projects/-tmp-demo/s2.jsonl").write_text(json.dumps(line) + "\n")
        self.ingest()
        self.assertEqual(self.titles()["s2"], "Newest name")

    def test_t3_title_goes_through_title_from_text(self):
        self.write_t3_title("T1", "$poteto-mode move the host from railway to cloudflare; audit it first")
        self.ingest()
        self.assertEqual(self.titles()["s1"], "Move the host from railway to cloudflare")

    def write_t3_title(self, thread_id, title):
        db = sqlite3.connect(self.homes["t3"] / "statev2.sqlite")
        db.execute("UPDATE orchestration_v2_projection_threads SET title = ? WHERE thread_id = ?", (title, thread_id))
        db.commit()
        db.close()

    def test_renamed_t3_thread_updates_on_the_next_ingest(self):
        self.ingest()
        self.write_t3_title("T1", "Renamed in T3")
        self.ingest()
        self.assertEqual(self.titles()["s1"], "Renamed in T3")

    def test_missing_or_locked_db_leaves_harness_titles(self):
        (self.homes["t3"] / "statev2.sqlite").unlink()
        (self.homes["t3"] / "statev2.sqlite").mkdir()
        self.ingest()
        got = self.titles()
        self.assertEqual((got["s1"], got["R"]), ("Demo title", "Codex stored title"))


class GrokTest(IngestCase):
    def test_root_uses_usage_json_plus_only_turns_after_updated_at(self):
        self.ingest()
        self.assertEqual(
            self.rows(RESPONSES, "grok"),
            [
                ("2026-10-10T10:00:05.000Z", "grok-x", 1000, 600, 100, "G1", "G1"),
                ("2026-10-10T10:00:09.000Z", "grok-x", 300, 100, 30, "G1", "G1"),
                ("2026-10-10T10:00:09.000Z", "grok-y", 200, 0, 20, "G1", "G1"),
                ("2026-10-10T10:00:20.000Z", "grok-x", 700, 200, 40, "G1", "G1"),
            ],
        )

    def test_child_dirs_emit_no_tokens_but_their_tool_calls_roll_into_the_root_session(self):
        self.ingest()
        self.assertEqual(
            self.rows("SELECT thread_id, session_id, tool FROM events WHERE harness='grok' AND kind='tool_call' ORDER BY ts"),
            [("G1", "G1", "read_file"), ("G1", "G1", "bash"), ("C1", "G1", "grep"), ("C2", "G1", "glob")],
        )
        self.assertEqual(self.rows("SELECT COUNT(*) FROM events WHERE harness='grok' AND kind='response' AND thread_id IN ('C1','C2')"), [(0,)])

    def test_nested_edges_resolve_to_the_root(self):
        self.ingest()
        self.assertEqual(
            self.rows("SELECT thread_id, session_id, parent_thread_id FROM threads WHERE harness='grok' ORDER BY thread_id"),
            [("C1", "G1", "G1"), ("C2", "G1", "C1"), ("G1", "G1", None)],
        )
        self.assertEqual([r for r in queries.totals(self.conn) if r["harness"] == "grok"][0]["sessions"], 1)

    def test_prompt_history_prompts_attach_to_their_session(self):
        self.ingest()
        self.assertEqual(
            self.rows("SELECT ts, session_id, project, text FROM events WHERE harness='grok' AND kind='prompt' ORDER BY ts"),
            [("2026-10-10T10:00:00.000Z", "G1", "/tmp/demo", "first grok prompt"), ("2026-10-10T10:00:15.000Z", "G1", "/tmp/demo", "second grok prompt")],
        )

    def test_title_is_generated_title(self):
        self.ingest()
        self.assertEqual(self.rows("SELECT title FROM threads WHERE thread_id='G1'"), [("Grok demo",)])

    def test_inconsistent_model_usage_falls_back_to_turn_totals_under_primary_model(self):
        session = self.homes["grok"] / "sessions" / "%2Ftmp%2Fother" / "G9"
        session.mkdir(parents=True)
        (session / "summary.json").write_text(json.dumps({"info": {"id": "G9", "cwd": "/tmp/other"}, "current_model_id": "fallback-model"}))
        turn = {"endedAt": "2026-10-10T11:00:00Z", "inputTokens": 100, "outputTokens": 10, "cachedReadTokens": 40, "primaryModelId": "primary",
                "modelUsage": {"a": {"inputTokens": 60, "outputTokens": 10, "cachedReadTokens": 40}}}
        (session / "usage.json").write_text(json.dumps({"updatedAt": "2026-10-10T11:00:01Z", "turns": [turn]}))
        parsed = grok.parse(session)
        self.assertEqual([(e.model, e.input_tokens, e.cached_tokens, e.output_tokens) for e in parsed.events], [("primary", 100, 40, 10)])


class IngestTest(IngestCase):
    def test_second_run_changes_nothing(self):
        first = self.ingest()
        before = self.dump()
        second = self.ingest()
        self.assertEqual((first["parsed"], first["units"]), (8, 8))
        self.assertEqual((second["parsed"], second["unchanged"], second["removed"]), (0, 8, 0))
        self.assertEqual(self.dump(), before)

    def test_totals_per_harness(self):
        self.ingest()
        got = {r["harness"]: (r["sessions"], r["input_tokens"], r["cached_tokens"], r["output_tokens"], r["prompts"], r["tool_calls"], r["responses"]) for r in queries.totals(self.conn)}
        self.assertEqual(
            got,
            {
                "claude": (1, 513, 409, 62, 1, 2, 3),
                "codex": (1, 3600, 2350, 65, 1, 2, 4),
                "grok": (1, 2200, 900, 190, 2, 4, 4),
            },
        )

    def test_changed_unit_is_reparsed_in_place_without_duplicates(self):
        self.ingest()
        path = self.homes["claude"] / "projects" / "-tmp-demo" / "s1.jsonl"
        extra = {"type": "assistant", "message": {"id": "m9", "model": "claude-x", "content": [], "usage": {"input_tokens": 3, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 4}},
                 "timestamp": "2026-10-10T10:00:06.000Z", "cwd": "/tmp/demo", "sessionId": "s1"}
        with open(path, "a") as fh:
            fh.write(json.dumps(extra) + "\n")
        stats = self.ingest()
        self.assertEqual(stats["parsed"], 1)
        claude = [r for r in queries.totals(self.conn) if r["harness"] == "claude"][0]
        self.assertEqual((claude["input_tokens"], claude["output_tokens"], claude["responses"]), (516, 66, 4))

    def test_vanished_unit_loses_its_rows_and_session_membership(self):
        self.ingest()
        shutil.rmtree(self.homes["grok"] / "sessions" / "%2Ftmp%2Fdemo" / "C2")
        stats = self.ingest()
        self.assertEqual(stats["removed"], 1)
        self.assertEqual(self.rows("SELECT thread_id FROM threads WHERE harness='grok' ORDER BY thread_id"), [("C1",), ("G1",)])
        self.assertEqual(self.rows("SELECT COUNT(*) FROM events WHERE tool='glob'"), [(0,)])
        self.assertEqual(self.rows("SELECT COUNT(*) FROM edges"), [(2,)])

    def test_parent_edge_loss_returns_child_to_its_own_session(self):
        self.ingest()
        updates = self.homes["grok"] / "sessions" / "%2Ftmp%2Fdemo" / "G1" / "updates.jsonl"
        lines = updates.read_text().splitlines()
        updates.write_text("\n".join(lines[1:]) + "\n")
        self.ingest()
        self.assertEqual(self.rows("SELECT thread_id, session_id FROM threads WHERE thread_id IN ('C1','C2') ORDER BY 1"), [("C1", "C1"), ("C2", "C1")])


class ClaudeSubagentPathTest(IngestCase):
    def test_a_home_with_a_subagents_directory_does_not_make_main_transcripts_subagents(self):
        from agenttrack.adapters import claude
        src = self.homes["claude"] / "projects" / "-tmp-demo" / "s1.jsonl"
        nested = self.tmp / "subagents" / "home" / "s1.jsonl"
        nested.parent.mkdir(parents=True)
        shutil.copy(src, nested)
        parsed = claude.parse(nested)
        self.assertTrue(any(t.thread_id == "s1" and t.parent_thread_id is None for t in parsed.threads))


class ResilienceTest(IngestCase):
    def events(self, harness):
        return self.rows("SELECT COUNT(*) FROM events WHERE harness = ?", harness)[0][0]

    def test_history_survives_an_adapter_that_is_not_loaded(self):
        from agenttrack.adapters import load_adapters
        self.ingest()
        before = self.events("grok")
        self.assertGreater(before, 0)
        without_grok = [a for a in load_adapters([]) if a.id != "grok"]
        stats = store.ingest(self.conn, self.homes, adapters=without_grok)
        self.assertEqual((stats["removed"], self.events("grok")), (0, before))

    def test_history_survives_a_missing_home_but_real_deletions_still_purge(self):
        self.ingest()
        before = self.events("grok")
        shutil.move(self.homes["grok"], self.tmp / "unmounted")
        self.assertEqual((self.ingest()["removed"], self.events("grok")), (0, before))
        shutil.move(self.tmp / "unmounted", self.homes["grok"])
        shutil.rmtree(self.homes["grok"] / "sessions")
        (self.homes["grok"] / "sessions").mkdir()
        self.assertEqual(self.ingest()["removed"] > 0, True)
        self.assertEqual(self.events("grok"), 0)

    def test_an_adapter_whose_units_or_titles_raise_does_not_abort_ingest(self):
        from agenttrack.adapters import Cap, load_adapters
        from agenttrack.model import Parsed

        class Raising:
            id = "raising"
            display_name = "Raising"
            capabilities = frozenset({Cap.INGEST, Cap.TITLES})
            process_names = ()

            def __init__(self, bad):
                self.bad = bad

            def homes(self, env):
                return []

            def detect(self, env):
                return None

            def units(self, home):
                if self.bad == "units":
                    raise RuntimeError("units bug")
                return []

            def members(self, unit):
                return [unit]

            def parse(self, unit):
                return Parsed([], [], [])

            def titles(self, home):
                raise RuntimeError("titles bug")

        for bad in ("units", "titles"):
            with self.subTest(bad=bad):
                logs = []
                stats = store.ingest(self.conn, {**self.homes, "raising": self.tmp}, log=logs.append,
                                     adapters=[*load_adapters([]), Raising(bad)])
                self.assertGreater(stats["units"], 0)
                self.assertTrue(any(f"{bad} failed for raising" in m for m in logs))


if __name__ == "__main__":
    unittest.main()
