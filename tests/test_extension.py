"""Static checks for the Tether Chrome extension. The point of Tether is that
nothing outside this computer can drive your browser, so the extension must stay
display-only: no network, no debugger, no way for other extensions or sites to
send it commands. These tests fail if a change quietly widens that.

The full in-browser test is tests/extension-e2e.mjs (needs Node and Chrome)."""

import json
import os
import re
import struct
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "extension")
HOOK = os.path.join(ROOT, "hooks", "claude-tab-marker.js")


def read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


class ManifestTest(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(EXT, "manifest.json"), encoding="utf-8") as handle:
            self.m = json.load(handle)

    def test_manifest_v3(self):
        self.assertEqual(self.m["manifest_version"], 3)
        self.assertRegex(self.m["version"], r"^\d+\.\d+\.\d+$")

    def test_only_the_permissions_it_needs(self):
        self.assertEqual(sorted(self.m.get("permissions", [])), ["storage", "tabGroups"])
        for key in ("host_permissions", "optional_permissions", "optional_host_permissions",
                    "externally_connectable", "web_accessible_resources", "content_security_policy"):
            self.assertNotIn(key, self.m, key)

    def test_name_is_not_claude(self):
        # Chrome Web Store rejects names that impersonate another product
        self.assertNotIn("claude", self.m["name"].lower())
        self.assertNotIn("anthropic", self.m["name"].lower())

    def test_content_script_top_frame_only(self):
        (cs,) = self.m["content_scripts"]
        self.assertEqual(cs["js"], ["content.js"])
        self.assertFalse(cs.get("all_frames", False))
        self.assertEqual(self.m["background"], {"service_worker": "background.js"})

    def test_icons_exist_with_the_right_size(self):
        for size, rel in self.m["icons"].items():
            with open(os.path.join(EXT, rel), "rb") as handle:
                head = handle.read(24)
            self.assertEqual(head[:8], b"\x89PNG\r\n\x1a\n", rel)
            width, height = struct.unpack(">II", head[16:24])
            self.assertEqual((width, height), (int(size), int(size)), rel)


class NoNetworkTest(unittest.TestCase):
    NETWORK = re.compile(r"\b(fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|"
                         r"chrome\.debugger|connectNative|sendNativeMessage|runtime\.connect\b|onMessageExternal|"
                         r"onConnectExternal|eval\s*\(|new Function)")

    def test_extension_code_never_talks_to_the_network(self):
        for name in sorted(os.listdir(EXT)):
            if name.endswith(".js"):
                found = self.NETWORK.findall(read(os.path.join(EXT, name)))
                self.assertEqual(found, [], name)

    def test_background_only_answers_its_own_content_scripts(self):
        bg = read(os.path.join(EXT, "background.js"))
        self.assertIn("sender.id !== chrome.runtime.id", bg)
        self.assertIn("!sender.tab", bg)

    def test_overlay_never_blocks_the_page(self):
        cs = read(os.path.join(EXT, "content.js"))
        self.assertIn("pointer-events: none", cs)
        self.assertIn("mode: 'closed'", cs)


class HookTest(unittest.TestCase):
    def test_hook_signals_the_extension_and_falls_back(self):
        hook = read(HOOK)
        self.assertTrue(hook.lstrip().startswith("async () =>"))
        self.assertIn("tether: 'claude-active'", hook)
        self.assertIn("e.data.tether === 'ack'", hook)
        self.assertIn("__claudeTabMarker", hook)  # the old in-page marker stays as fallback

    def test_extension_and_hook_use_the_same_message(self):
        cs = read(os.path.join(EXT, "content.js"))
        self.assertIn("d.tether !== 'claude-active'", cs)
        self.assertIn("tether: 'ack'", cs)


if __name__ == "__main__":
    unittest.main()
