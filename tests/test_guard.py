"""Behaviour tests for both guard hooks (Python and Windows PowerShell).

Each test copies the guard into a fresh temp folder with its own allowed-devices
file and state, then drives it the way Claude Code does: JSON on stdin, a
permission decision (or nothing) on stdout.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY_GUARD = os.path.join(ROOT, "hooks", "chrome_browser_guard.py")
PS_GUARD = os.path.join(ROOT, "hooks", "chrome_browser_guard.ps1")
POWERSHELL = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
MINE = "11111111-2222-3333-4444-555555555555"
OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
P = "mcp__claude-in-chrome__"


class GuardCases:
    source = None

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix=".tmp-guard-", dir=os.path.dirname(os.path.abspath(__file__)))
        shutil.copy(self.source, self.dir)
        with open(os.path.join(self.dir, "chrome-allowed-devices.txt"), "w", encoding="utf-8") as handle:
            handle.write(f"# test allow-list\n{MINE}  # my browser\n")
        self.guard = os.path.join(self.dir, os.path.basename(self.source))
        self.session = "test-session"

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    # -- helpers -----------------------------------------------------------
    def decide(self, payload):
        data = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        result = subprocess.run(self.command(), input=data, capture_output=True, timeout=60)
        out = result.stdout.decode("utf-8", "replace").strip()
        if not out:
            return "allow"
        return json.loads(out)["hookSpecificOutput"]["permissionDecision"]

    def pre(self, tool, tool_input=None):
        return self.decide({"hook_event_name": "PreToolUse", "session_id": self.session,
                            "tool_name": P + tool, "tool_input": tool_input or {}})

    def post(self, tool, response, tool_input=None):
        return self.decide({"hook_event_name": "PostToolUse", "session_id": self.session,
                            "tool_name": P + tool, "tool_input": tool_input or {}, "tool_response": response})

    def list_shows(self, in_use):
        rows = [{"deviceId": MINE, "name": "Browser 1", "inUse": in_use == MINE},
                {"deviceId": OTHER, "name": "Browser 1", "inUse": in_use == OTHER}]
        self.post("list_connected_browsers", [{"type": "text", "text": json.dumps(rows)}])

    # -- rules -------------------------------------------------------------
    def test_browser_actions_blocked_until_confirmed(self):
        self.assertEqual(self.pre("navigate", {"url": "https://mail.google.com"}), "deny")

    def test_list_connected_browsers_always_allowed(self):
        self.assertEqual(self.pre("list_connected_browsers"), "allow")

    def test_switch_browser_always_blocked(self):
        self.list_shows(MINE)
        self.assertEqual(self.pre("switch_browser"), "deny")

    def test_select_browser_only_for_allowed_ids(self):
        self.assertEqual(self.pre("select_browser", {"deviceId": OTHER}), "deny")
        self.assertEqual(self.pre("select_browser", {"deviceId": MINE}), "allow")
        self.assertEqual(self.pre("select_browser", {"deviceId": MINE.upper()}), "allow")

    def test_someone_elses_browser_in_use_stays_blocked(self):
        self.list_shows(OTHER)
        self.assertEqual(self.pre("navigate", {"url": "x"}), "deny")

    def test_own_browser_in_use_unlocks(self):
        self.list_shows(MINE)
        self.assertEqual(self.pre("navigate", {"url": "x"}), "allow")
        self.assertEqual(self.pre("tabs_context_mcp"), "allow")

    def test_switching_to_someone_else_relocks(self):
        self.list_shows(MINE)
        self.list_shows(OTHER)
        self.assertEqual(self.pre("navigate", {"url": "x"}), "deny")

    def test_batch_cannot_pick_a_browser(self):
        self.list_shows(MINE)
        self.assertEqual(self.pre("browser_batch", {"actions": [{"name": "switch_browser", "input": {}}]}), "deny")
        self.assertEqual(self.pre("browser_batch", {"actions": [{"name": P + "select_browser", "input": {"deviceId": MINE}}]}), "deny")
        self.assertEqual(self.pre("browser_batch", {"actions": [{"name": "navigate", "input": {"url": "x", "tabId": 1}}]}), "allow")

    def test_selecting_again_needs_a_new_check(self):
        self.list_shows(MINE)
        self.post("select_browser", [{"type": "text", "text": "ok"}], {"deviceId": MINE})
        self.assertEqual(self.pre("navigate", {"url": "x"}), "deny")

    def test_list_response_as_plain_string(self):
        self.post("list_connected_browsers", json.dumps([{"deviceId": MINE, "inUse": True}]))
        self.assertEqual(self.pre("navigate", {"url": "x"}), "allow")

    def test_check_expires(self):
        self.list_shows(MINE)
        state = os.path.join(self.dir, "chrome-guard-state", self.session)
        old = time.time() - 31 * 60
        os.utime(state, (old, old))
        self.assertEqual(self.pre("navigate", {"url": "x"}), "deny")

    def test_non_english_text_allowed_once_confirmed(self):
        self.list_shows(MINE)
        self.assertEqual(self.pre("computer", {"action": "type", "text": "یہ اردو متن ہے — پاکستان", "tabId": 1}), "allow")

    def test_unreadable_input_fails_closed(self):
        self.assertEqual(self.decide(b"not json"), "deny")
        self.assertEqual(self.decide(b""), "deny")


class PythonGuardTest(GuardCases, unittest.TestCase):
    source = PY_GUARD

    def command(self):
        return [sys.executable, "-I", self.guard]


@unittest.skipUnless(os.name == "nt" and os.path.exists(POWERSHELL), "Windows PowerShell only")
class PowerShellGuardTest(GuardCases, unittest.TestCase):
    source = PS_GUARD

    def command(self):
        return [POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", self.guard]


if __name__ == "__main__":
    unittest.main()
