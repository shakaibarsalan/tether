"""hooks/tab-guard.mjs: Claude works in its own tabs, not in the one you're using.
Feeds it the same JSON Claude Code sends to PreToolUse/PostToolUse hooks."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GUARD = os.path.join(ROOT, "hooks", "tab-guard.mjs")
NODE = shutil.which("node")
NEW_PAGE_RESULT = [{"type": "text", "text": "## Pages\n1: Gmail (https://mail.google.com/)\n2: Docs (https://docs.example/)\n7: about:blank [selected]"}]


@unittest.skipUnless(NODE, "Node.js needed")
class TabGuardTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix=".tmp-guard-", dir=os.path.dirname(os.path.abspath(__file__)))
        self.session = "11111111-aaaa-bbbb-cccc-222222222222"

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def call(self, event, tool, tool_input=None, tool_response=None, session=None):
        payload = {"hook_event_name": event, "session_id": session or self.session,
                   "tool_name": f"mcp__chrome-devtools__{tool}", "tool_input": tool_input or {}}
        if tool_response is not None:
            payload["tool_response"] = tool_response
        r = subprocess.run([NODE, GUARD], input=json.dumps(payload), capture_output=True, text=True,
                           env={**os.environ, "TETHER_TAB_GUARD_DIR": self.dir}, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        if not r.stdout.strip():
            return "allow"
        out = json.loads(r.stdout)["hookSpecificOutput"]
        return out["permissionDecision"] + ": " + out["permissionDecisionReason"]

    def test_acting_before_opening_a_tab_is_refused(self):
        for tool in ("navigate_page", "click", "fill", "type_text", "press_key"):
            self.assertTrue(self.call("PreToolUse", tool).startswith("deny"), tool)

    def test_looking_is_always_allowed(self):
        for tool in ("list_pages", "take_snapshot", "take_screenshot", "evaluate_script", "wait_for"):
            self.assertEqual(self.call("PreToolUse", tool), "allow", tool)

    def test_own_tab_then_acting_is_allowed(self):
        self.assertEqual(self.call("PreToolUse", "new_page", {"url": "https://example.com"}), "allow")
        self.call("PostToolUse", "new_page", {"url": "https://example.com"}, NEW_PAGE_RESULT)
        self.assertEqual(self.call("PreToolUse", "navigate_page", {"url": "https://example.org"}), "allow")
        self.assertEqual(self.call("PreToolUse", "select_page", {"pageId": 7}), "allow")
        self.assertEqual(self.call("PreToolUse", "close_page", {"pageId": 7}), "allow")

    def test_someone_elses_tab_needs_a_second_deliberate_call(self):
        first = self.call("PreToolUse", "select_page", {"pageId": 1})
        self.assertTrue(first.startswith("deny") and "new_page" in first and "pageId 1 again" in first, first)
        self.assertEqual(self.call("PreToolUse", "select_page", {"pageId": 1}), "allow")
        self.assertEqual(self.call("PreToolUse", "click", {"uid": "1_2"}), "allow")

    def test_a_different_tab_resets_the_confirmation(self):
        self.call("PreToolUse", "select_page", {"pageId": 1})
        self.assertTrue(self.call("PreToolUse", "select_page", {"pageId": 2}).startswith("deny"))
        self.assertTrue(self.call("PreToolUse", "select_page", {"pageId": 1}).startswith("deny"))

    def test_closing_the_users_tab_is_refused_once(self):
        self.call("PreToolUse", "new_page", {"url": "https://example.com"})
        self.call("PostToolUse", "new_page", {}, NEW_PAGE_RESULT)
        self.assertTrue(self.call("PreToolUse", "close_page", {"pageId": 1}).startswith("deny"))

    def test_sessions_are_separate(self):
        self.call("PreToolUse", "new_page", {"url": "https://example.com"})
        self.call("PostToolUse", "new_page", {}, NEW_PAGE_RESULT)
        other = "99999999-aaaa-bbbb-cccc-222222222222"
        self.assertTrue(self.call("PreToolUse", "navigate_page", {"url": "x"}, session=other).startswith("deny"))


if __name__ == "__main__":
    unittest.main()
