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
                           env={**os.environ, "TETHER_TAB_GUARD_DIR": self.dir, "TETHER_BROKER_PORT": "1"}, timeout=30)
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

    def test_closing_its_own_tab_stops_it_on_the_fallback_tab(self):
        # chrome-devtools-mcp falls back to the first tab (the user's) when the selected one closes
        self.call("PreToolUse", "new_page", {"url": "https://example.com"})
        self.call("PostToolUse", "new_page", {}, NEW_PAGE_RESULT)
        self.assertEqual(self.call("PreToolUse", "close_page", {"pageId": 7}), "allow")
        self.call("PostToolUse", "close_page", {"pageId": 7}, [{"type": "text", "text":
            "Note: the previously selected page was closed. Page 1 is now selected.\n## Pages\n1: Gmail (https://mail.google.com/) [selected]\n2: Docs"}])
        self.assertTrue(self.call("PreToolUse", "navigate_page", {"url": "https://example.org"}).startswith("deny"))
        self.assertTrue(self.call("PreToolUse", "click", {"uid": "1_2"}).startswith("deny"))

    def test_any_answer_that_shows_a_users_tab_selected_stops_it(self):
        self.call("PreToolUse", "new_page", {"url": "https://example.com"})
        self.call("PostToolUse", "new_page", {}, NEW_PAGE_RESULT)
        self.call("PostToolUse", "list_pages", {}, [{"type": "text", "text": "## Pages\n1: Gmail [selected]\n7: about:blank"}])
        self.assertTrue(self.call("PreToolUse", "fill", {"uid": "1_3", "value": "x"}).startswith("deny"))
        # back on its own tab: fine again
        self.assertEqual(self.call("PreToolUse", "select_page", {"pageId": 7}), "allow")
        self.call("PostToolUse", "select_page", {"pageId": 7}, [{"type": "text", "text": "## Pages\n1: Gmail\n7: about:blank [selected]"}])
        self.assertEqual(self.call("PreToolUse", "fill", {"uid": "1_3", "value": "x"}), "allow")


    def test_a_separate_signed_out_context_is_questioned_once(self):
        first = self.call("PreToolUse", "new_page", {"url": "https://example.com", "isolatedContext": "test"})
        self.assertTrue(first.startswith("deny") and "sign-ins" in first and "without it" in first, first)
        self.assertEqual(self.call("PreToolUse", "new_page", {"url": "https://example.com", "isolatedContext": "test"}), "allow")
        self.assertEqual(self.call("PreToolUse", "new_page", {"url": "https://example.com"}), "allow")


class FakeBroker:
    """/status says the broker is up; /adopt calls are recorded."""

    def __init__(self):
        import http.server
        import threading
        adopts = self.adopts = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200 if self.path == "/status" else 404)
                self.end_headers()
                self.wfile.write(b'{"chrome":"connected","clients":[]}')

            def do_POST(self):
                adopts.append(json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}"))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"lent":1}')

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@unittest.skipUnless(NODE, "Node.js needed")
class TabGuardWithBrokerTest(TabGuardTest):
    """With the broker running, the broker decides by Chrome's tab ids; the guard passes on the user's permission."""

    def setUp(self):
        super().setUp()
        self.broker = FakeBroker()
        self.addCleanup(self.broker.close)

    def call(self, event, tool, tool_input=None, tool_response=None, session=None):
        payload = {"hook_event_name": event, "session_id": session or self.session,
                   "tool_name": f"mcp__chrome-devtools__{tool}", "tool_input": tool_input or {}}
        if tool_response is not None:
            payload["tool_response"] = tool_response
        r = subprocess.run([NODE, GUARD], input=json.dumps(payload), capture_output=True, text=True,
                           env={**os.environ, "TETHER_TAB_GUARD_DIR": self.dir, "TETHER_BROKER_PORT": str(self.broker.port)}, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        if not r.stdout.strip():
            return "allow"
        out = json.loads(r.stdout)["hookSpecificOutput"]
        return out["permissionDecision"] + ": " + out["permissionDecisionReason"]

    # the guard-only rules (no broker) don't apply here: the broker refuses by tab id
    test_acting_before_opening_a_tab_is_refused = None
    test_someone_elses_tab_needs_a_second_deliberate_call = None
    test_a_different_tab_resets_the_confirmation = None
    test_closing_the_users_tab_is_refused_once = None
    test_sessions_are_separate = None
    test_closing_its_own_tab_stops_it_on_the_fallback_tab = None
    test_any_answer_that_shows_a_users_tab_selected_stops_it = None

    def test_choosing_and_closing_tabs_is_left_to_the_broker(self):
        # its own tabs after a reconnect (new page numbers) or a new_page that timed out: closing them works
        for tool, page in (("select_page", 212), ("close_page", 212), ("close_page", 16), ("select_page", 1)):
            self.assertEqual(self.call("PreToolUse", tool, {"pageId": page}), "allow", (tool, page))
        self.assertEqual(self.call("PreToolUse", "navigate_page", {"url": "https://example.org"}), "allow")
        self.assertEqual(self.broker.adopts, [])

    def test_the_same_tab_chosen_again_passes_on_the_users_permission(self):
        self.call("PreToolUse", "select_page", {"pageId": 1})
        self.assertEqual(self.broker.adopts, [])
        self.assertEqual(self.call("PreToolUse", "select_page", {"pageId": 1}), "allow")
        self.assertEqual(len(self.broker.adopts), 1)
        self.assertEqual(self.broker.adopts[0]["chat"], True)
        self.assertEqual(self.broker.adopts[0]["session"], self.session)

    def test_another_tab_in_between_is_no_confirmation(self):
        self.call("PreToolUse", "select_page", {"pageId": 1})
        self.call("PreToolUse", "select_page", {"pageId": 2})
        self.call("PreToolUse", "select_page", {"pageId": 1})
        self.assertEqual(self.broker.adopts, [])


if __name__ == "__main__":
    unittest.main()
