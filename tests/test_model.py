import unittest

from agenttrack.model import title_from_text


class TitleFromTextTest(unittest.TestCase):
    def test_slash_command_uses_args(self):
        raw = (
            "<command-message>demo-skill</command-message> <command-name>/demo-skill</command-name> "
            "<command-args>Create a pre-commit hook that prevents files over 5,000 tokens. Keep it fast.</command-args>"
        )
        self.assertEqual(title_from_text(raw), "Create a pre-commit hook that prevents files over 5,000 tokens")

    def test_slash_command_without_args_is_the_command_name(self):
        raw = "<command-message>demo-skill</command-message> <command-name>/demo-skill</command-name> <command-args></command-args>"
        self.assertEqual(title_from_text(raw), "/demo-skill")
        self.assertEqual(title_from_text("$demo-skill"), "$demo-skill")

    def test_skill_prefix_is_dropped_and_sentence_cased(self):
        raw = "$demo-skill i want to move example.com host from provider-a to provider-b; need you audit and come up with a aut"
        self.assertEqual(title_from_text(raw), "I want to move example.com host from provider-a to provider-b")

    def test_subagent_brief_cuts_at_first_sentence(self):
        raw = "You own one small fix PR in the Acme repo, from code to a draft PR. Tool-call budget: 60."
        self.assertEqual(title_from_text(raw), "You own one small fix PR in the Acme repo, from code to a draft PR")

    def test_task_notification(self):
        self.assertEqual(title_from_text("<task-notification><summary>Agent finished</summary><id>1</id></task-notification>"), "Task update: Agent finished")
        self.assertEqual(title_from_text("<task-notification><id>1</id></task-notification>"), "Task update")

    def test_wrapper_blocks_drop_their_content_and_unclosed_run_to_the_end(self):
        self.assertEqual(title_from_text("<system-reminder>noise</system-reminder>Fix the login page"), "Fix the login page")
        self.assertIsNone(title_from_text("<local-command-stdout>output</local-command-stdout>"))
        self.assertIsNone(title_from_text("<system-reminder>never closed"))

    def test_plain_sentence_is_unchanged(self):
        self.assertEqual(title_from_text("Fix review findings on PR 221"), "Fix review findings on PR 221")
        self.assertEqual(title_from_text("iOS crash on launch when the user taps twice"), "iOS crash on launch when the user taps twice")

    def test_short_text_with_inner_period_stays_whole(self):
        self.assertEqual(title_from_text("Use v1. Ship it"), "Use v1. Ship it")

    def test_newline_ends_the_title_once_long_enough(self):
        self.assertEqual(title_from_text("# Plan the migration of the billing tables\nstep one"), "Plan the migration of the billing tables")

    def test_long_text_cuts_on_a_word_boundary(self):
        title = title_from_text("word " * 40)
        self.assertTrue(title.endswith("word…"))
        self.assertLessEqual(len(title), 80)

    def test_url_stays_whole(self):
        url = "https://example.com/" + "a/" * 60 + "end"
        self.assertEqual(title_from_text(url), url)

    def test_image_markers_and_notes(self):
        self.assertEqual(title_from_text("[Attached image 1] look at this screenshot"), "Look at this screenshot")
        self.assertEqual(title_from_text("[Request interrupted by user]"), "Request interrupted by user")

    def test_nothing_readable_is_none(self):
        self.assertIsNone(title_from_text(""))
        self.assertIsNone(title_from_text(None))
        self.assertIsNone(title_from_text("   <b></b> ... "))


if __name__ == "__main__":
    unittest.main()
