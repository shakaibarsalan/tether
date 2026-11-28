"""What every Claude session is told at its start (hooks/session-start.mjs), the
list of Chrome profiles behind it (scripts/lib/chrome-profiles.mjs and, on a Mac,
mac/chrome-profiles.c), and the settings that install it. All on temp folders,
never your real Chrome or settings."""

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
HOOK = os.path.join(ROOT, "hooks", "session-start.mjs")
SETTINGS_TOOL = os.path.join(ROOT, "scripts", "lib", "claude-settings.mjs")
HELPER = os.path.join(ROOT, "mac", "chrome-profiles.c")
MAC = sys.platform == "darwin"
TETHER_ID = "a" * 32
OTHER_ID = "b" * 32

LOCAL_STATE = {
    "os_crypt": {"encrypted_key": "NOT-FOR-TETHER"},
    "profile": {
        "last_used": "Profile 2",
        "info_cache": {
            "Default": {"name": "Person 1", "user_name": ""},
            "Profile 2": {"name": "Xaibridge", "user_name": "me@example.com", "gaia_name": "A \"B\" C"},
            "Profile 3": {"name": "Work {x}", "user_name": "work@example.com"},
        },
    },
    "variations_seed": "NOT-FOR-TETHER",
}


def fake_chrome(base):
    """A Chrome folder with three profiles; the Tether extension is in Profile 2."""
    chrome = os.path.join(base, "Chrome")
    for p in ("Default", "Profile 2", "Profile 3"):
        os.makedirs(os.path.join(chrome, p))
    with open(os.path.join(chrome, "Local State"), "w") as h:
        json.dump(LOCAL_STATE, h)
    with open(os.path.join(chrome, "Profile 2", "Secure Preferences"), "w") as h:
        json.dump({"extensions": {"settings": {TETHER_ID: {"path": "/x/extension"}}}}, h)
    with open(os.path.join(chrome, "Profile 3", "Preferences"), "w") as h:
        json.dump({"extensions": {"settings": {OTHER_ID: {}}}}, h)
    with open(os.path.join(chrome, "Default", "Preferences"), "w") as h:
        h.write("{}")
    home = os.path.join(base, "tether")
    os.makedirs(home)
    with open(os.path.join(home, "config.json"), "w") as h:
        json.dump({"extensionIds": [TETHER_ID]}, h)
    return chrome, home


def node_json(code, env=None):
    url = "file:///" + os.path.join(ROOT, "scripts", "lib", "chrome-profiles.mjs").replace("\\", "/").lstrip("/")
    r = subprocess.run([NODE, "--input-type=module", "-e", f"import * as p from {json.dumps(url)};\n{code}"],
                       capture_output=True, text=True, encoding="utf-8", timeout=60, env={**os.environ, **(env or {})})
    if r.returncode != 0:
        raise AssertionError(r.stderr)
    return json.loads(r.stdout)


@unittest.skipUnless(NODE, "Node.js needed")
class ChromeProfilesTest(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp(prefix="tether-profiles-")
        self.addCleanup(shutil.rmtree, self.base, True)
        self.chrome, self.home = fake_chrome(self.base)

    def test_read_from_chromes_own_files(self):
        out = node_json(f"console.log(JSON.stringify(p.chromeProfiles({{ platform: 'win32', chromeDir: {json.dumps(self.chrome)}, tetherHome: {json.dumps(self.home)} }})));")
        self.assertEqual(out["profiles"][0], {"dir": "Profile 2", "name": "Xaibridge", "email": "me@example.com", "tether": True})
        self.assertEqual([p["tether"] for p in out["profiles"]], [True, False, False])
        self.assertEqual({p["name"] for p in out["profiles"]}, {"Xaibridge", "Person 1", "Work {x}"})

    def test_read_from_the_mac_helpers_list(self):
        os.makedirs(os.path.join(self.home, "chrome"))
        with open(os.path.join(self.home, "chrome", "profiles.json"), "w") as h:
            json.dump({"info_cache": LOCAL_STATE["profile"]["info_cache"], "tether": ["Profile 3"]}, h)
        out = node_json(f"console.log(JSON.stringify(p.chromeProfiles({{ platform: 'darwin', chromeDir: null, tetherHome: {json.dumps(self.home)} }})));")
        self.assertEqual(out["profiles"][0]["name"], "Work {x}")
        self.assertTrue(out["profiles"][0]["tether"])

    def test_no_list_says_why(self):
        out = node_json(f"console.log(JSON.stringify(p.chromeProfiles({{ platform: 'darwin', chromeDir: null, tetherHome: {json.dumps(self.home)} }})));")
        self.assertEqual(out["profiles"], [])
        self.assertIn("Full Disk Access", out["note"])

    def test_extension_id_is_chromes(self):
        # seen on Windows: C:\Drive\tether\extension loaded unpacked is gnjnmlhgeobmcdiceboflhdfehlmjlnd
        out = node_json("console.log(JSON.stringify(p.unpackedExtensionId('C:\\\\Drive\\\\tether\\\\extension', 'win32')));")
        self.assertEqual(out, "gnjnmlhgeobmcdiceboflhdfehlmjlnd")


@unittest.skipUnless(NODE, "Node.js needed")
class SessionStartHookTest(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp(prefix="tether-session-")
        self.addCleanup(shutil.rmtree, self.base, True)
        self.chrome, self.home = fake_chrome(self.base)

    def run_hook(self, **env):
        r = subprocess.run([NODE, HOOK], capture_output=True, text=True, encoding="utf-8", timeout=60,
                           env={**os.environ, "TETHER_HOME": self.home, "TETHER_BROKER_PORT": "1", **env})
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)["hookSpecificOutput"]
        self.assertEqual(out["hookEventName"], "SessionStart")
        return out["additionalContext"]

    def test_tells_the_session_how_the_browser_works_here(self):
        text = self.run_hook(TETHER_CHROME_DIR=self.chrome)
        for words in ("chrome-devtools MCP tools", "mcp__claude-in-chrome", "never ask the user to reconnect",
                      "broker-setup", "never with isolatedContext", '"not yours"', "the broker was not answering"):
            self.assertIn(words, text)

    def test_names_the_profiles_and_where_tabs_open(self):
        text = self.run_hook(TETHER_CHROME_DIR=self.chrome)
        self.assertIn('"Xaibridge" (me@example.com): has the Tether extension', text)
        self.assertIn('"Work {x}" (work@example.com)', text)
        self.assertIn('Your new tabs open in "Xaibridge"', text)
        self.assertNotIn("NOT-FOR-TETHER", text)

    def test_without_the_extension_anywhere_it_says_what_to_do(self):
        os.remove(os.path.join(self.chrome, "Profile 2", "Secure Preferences"))
        text = self.run_hook(TETHER_CHROME_DIR=self.chrome)
        self.assertIn("None has the Tether extension", text)
        self.assertIn("Load unpacked", text)


@unittest.skipUnless(NODE, "Node.js needed")
class SessionStartSettingsTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="tether-settings-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.path = os.path.join(self.dir, "settings.json")
        with open(self.path, "w") as h:
            json.dump({"permissions": {"allow": ["Bash(ls)"], "deny": ["Bash(rm -rf /)"]},
                       "hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "mine-too"}]}]}}, h)

    def tool(self, *extra):
        r = subprocess.run([NODE, SETTINGS_TOOL, "session-start", "--claude-dir", self.dir, "--node", "/x/node", *extra],
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(self.path) as h:
            return json.load(h)

    def test_install_twice_then_undo(self):
        s = self.tool()
        s = self.tool()
        ours = [e for e in s["hooks"]["SessionStart"] if "session-start.mjs" in json.dumps(e)]
        self.assertEqual(len(ours), 1)
        self.assertEqual(ours[0]["hooks"][0]["command"], "/x/node")
        self.assertEqual(s["permissions"]["deny"], ["Bash(rm -rf /)", "mcp__claude-in-chrome"])
        self.assertEqual(s["permissions"]["allow"], ["Bash(ls)"])
        s = self.tool("--undo")
        self.assertEqual(s["permissions"], {"allow": ["Bash(ls)"], "deny": ["Bash(rm -rf /)"]})
        self.assertEqual(s["hooks"]["SessionStart"], [{"hooks": [{"type": "command", "command": "mine-too"}]}])


@unittest.skipUnless(MAC and shutil.which("clang"), "macOS with clang")
class ChromeProfilesHelperTest(unittest.TestCase):
    """The small program that gets Full Disk Access instead of node."""

    def setUp(self):
        self.base = tempfile.mkdtemp(prefix="tether-helper-")
        self.addCleanup(shutil.rmtree, self.base, True)
        self.chrome, self.home = fake_chrome(self.base)
        os.makedirs(os.path.join(self.home, "chrome"))
        with open(os.path.join(self.home, "chrome", "tether-ids"), "w") as h:
            h.write(f"{TETHER_ID}\nnot-an-id\n")
        self.bin = os.path.join(self.base, "tether-chrome-profiles")
        subprocess.run(["clang", "-O2", "-Wall", "-Werror", "-o", self.bin, HELPER], check=True, timeout=120)

    def run_once(self):
        return subprocess.run([self.bin, "--once"], capture_output=True, text=True, timeout=60,
                              env={**os.environ, "TETHER_HOME": self.home, "TETHER_CHROME_DIR": self.chrome})

    def test_keeps_only_the_profile_list_and_the_tether_profiles(self):
        r = self.run_once()
        self.assertEqual(r.returncode, 0, r.stderr)
        out = os.path.join(self.home, "chrome", "profiles.json")
        with open(out) as h:
            text = h.read()
        data = json.loads(text)
        self.assertEqual(data["info_cache"], LOCAL_STATE["profile"]["info_cache"])
        self.assertEqual(data["tether"], ["Profile 2"])
        self.assertNotIn("NOT-FOR-TETHER", text)
        self.assertEqual(stat.S_IMODE(os.stat(out).st_mode), 0o600)

    def test_without_permission_it_says_so_and_writes_nothing(self):
        os.chmod(os.path.join(self.chrome, "Local State"), 0)
        self.addCleanup(os.chmod, os.path.join(self.chrome, "Local State"), 0o600)
        r = self.run_once()
        self.assertEqual(r.returncode, 2)
        self.assertIn("no permission", r.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.home, "chrome", "profiles.json")))


if __name__ == "__main__":
    unittest.main()
