"""Tests for the PowerShell scripts: the hosts-file bridge block and the guard
installer/uninstaller. Windows only. Nothing here touches the real hosts file or
the real Claude settings: every test works on copies in a temp folder."""

import copy
import json
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(ROOT, "scripts")
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "settings.sample.json")
POWERSHELL = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
MINE = "11111111-2222-3333-4444-555555555555"
BRIDGE = "bridge.claudeusercontent.com"


def run_script(name, *args):
    return subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", os.path.join(SCRIPTS, name), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)


def load(path):
    with open(path, encoding="utf-8-sig") as handle:
        return json.load(handle)


def without_guard(settings):
    s = copy.deepcopy(settings)
    hooks = s.get("hooks", {})
    for event in list(hooks):
        hooks[event] = [e for e in hooks[event] if "chrome_browser_guard" not in json.dumps(e)]
        if not hooks[event]:
            del hooks[event]
    if not hooks and "hooks" in s:
        del s["hooks"]
    return s


@unittest.skipUnless(os.name == "nt" and os.path.exists(POWERSHELL), "Windows PowerShell only")
class BridgeBlockTest(unittest.TestCase):
    SAMPLE = "# Copyright (c) Microsoft Corp.\r\n#\r\n# 127.0.0.1 localhost\r\n10.0.0.5 nas.local\r\n"

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix=".tmp-hosts-", dir=os.path.dirname(os.path.abspath(__file__)))
        self.hosts = os.path.join(self.dir, "hosts")
        with open(self.hosts, "w", encoding="utf-8", newline="") as handle:
            handle.write(self.SAMPLE)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def read(self):
        with open(self.hosts, encoding="utf-8", newline="") as handle:
            return handle.read()

    def test_block_adds_both_sinkholes_and_keeps_existing_lines(self):
        r = run_script("bridge-block.ps1", "-HostsFile", self.hosts)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        text = self.read()
        self.assertIn(f"0.0.0.0 {BRIDGE}", text)
        self.assertIn(f":: {BRIDGE}", text)
        self.assertTrue(text.startswith(self.SAMPLE))

    def test_running_twice_does_not_duplicate(self):
        run_script("bridge-block.ps1", "-HostsFile", self.hosts)
        once = self.read()
        run_script("bridge-block.ps1", "-HostsFile", self.hosts)
        self.assertEqual(self.read(), once)

    def test_undo_restores_the_original(self):
        run_script("bridge-block.ps1", "-HostsFile", self.hosts)
        r = run_script("bridge-block.ps1", "-HostsFile", self.hosts, "-Undo")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.read(), self.SAMPLE)

    def test_status_reports_both_states(self):
        self.assertIn("Open", run_script("bridge-block.ps1", "-HostsFile", self.hosts, "-Status").stdout)
        run_script("bridge-block.ps1", "-HostsFile", self.hosts)
        self.assertIn("Blocked", run_script("bridge-block.ps1", "-HostsFile", self.hosts, "-Status").stdout)

    def test_a_commented_out_entry_does_not_count_as_blocked(self):
        with open(self.hosts, "a", encoding="utf-8") as handle:
            handle.write(f"# 0.0.0.0 {BRIDGE}\r\n")
        self.assertIn("Open", run_script("bridge-block.ps1", "-HostsFile", self.hosts, "-Status").stdout)

    def test_file_without_final_newline(self):
        with open(self.hosts, "w", encoding="utf-8", newline="") as handle:
            handle.write("10.0.0.5 nas.local")
        run_script("bridge-block.ps1", "-HostsFile", self.hosts)
        self.assertIn("10.0.0.5 nas.local\r\n# >>> tether", self.read())

    def test_backup_is_written(self):
        run_script("bridge-block.ps1", "-HostsFile", self.hosts)
        self.assertTrue(any(n.startswith("hosts.bak-tether-") for n in os.listdir(self.dir)))


@unittest.skipUnless(os.name == "nt" and os.path.exists(POWERSHELL), "Windows PowerShell only")
class GuardInstallerTest(unittest.TestCase):
    def setUp(self):
        self.claude = tempfile.mkdtemp(prefix=".tmp-claude-", dir=os.path.dirname(os.path.abspath(__file__)))
        self.settings = os.path.join(self.claude, "settings.json")
        shutil.copy(FIXTURE, self.settings)
        self.original = load(self.settings)

    def tearDown(self):
        shutil.rmtree(self.claude, ignore_errors=True)

    def install(self, device=MINE):
        return run_script("guard-install.ps1", "-DeviceId", device, "-ClaudeDir", self.claude)

    def test_install_keeps_every_other_setting_and_passes_self_test(self):
        r = self.install()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("All self-tests passed", r.stdout)
        after = load(self.settings)
        self.assertEqual(without_guard(after), self.original)
        pre = [e for e in after["hooks"]["PreToolUse"] if "chrome_browser_guard" in json.dumps(e)]
        post = [e for e in after["hooks"]["PostToolUse"] if "chrome_browser_guard" in json.dumps(e)]
        self.assertEqual(len(pre), 1)
        self.assertEqual(len(post), 1)
        self.assertEqual(pre[0]["hooks"][0]["onFailure"], "block")
        self.assertIsInstance(pre[0]["hooks"][0]["args"], list)

    def test_reinstall_is_idempotent(self):
        self.install()
        self.install()
        after = load(self.settings)
        for event in ("PreToolUse", "PostToolUse"):
            self.assertEqual(sum("chrome_browser_guard" in json.dumps(e) for e in after["hooks"][event]), 1)
        with open(os.path.join(self.claude, "hooks", "chrome-allowed-devices.txt"), encoding="utf-8") as handle:
            self.assertEqual(handle.read().count(MINE), 1)

    def test_malformed_device_id_is_refused_and_nothing_changes(self):
        r = self.install("not-a-device-id")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(load(self.settings), self.original)

    def test_uninstall_restores_settings_and_removes_files(self):
        self.install()
        r = run_script("guard-uninstall.ps1", "-ClaudeDir", self.claude)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(load(self.settings), self.original)
        hooks_dir = os.path.join(self.claude, "hooks")
        for name in ("chrome_browser_guard.ps1", "chrome-allowed-devices.txt", "chrome-guard-state"):
            self.assertFalse(os.path.exists(os.path.join(hooks_dir, name)), name)

    def test_install_without_existing_settings(self):
        os.remove(self.settings)
        r = self.install()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        fresh = load(self.settings)
        self.assertIsInstance(fresh["hooks"]["PreToolUse"], list)
        self.assertIsInstance(fresh["hooks"]["PostToolUse"], list)


@unittest.skipUnless(os.name == "nt" and os.path.exists(POWERSHELL), "Windows PowerShell only")
class CheckScriptTest(unittest.TestCase):
    EXT = "fcoeoabgfenejglbffodgkkbkcdhcgfn"
    KNOWN_JS = 'const a="wss://bridge.claudeusercontent.com",b="wss://api.anthropic.com",c="ws://localhost:8765";'

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix=".tmp-check-", dir=os.path.dirname(os.path.abspath(__file__)))
        self.hosts = os.path.join(self.dir, "hosts")
        with open(self.hosts, "w", encoding="utf-8") as handle:
            handle.write(f"0.0.0.0 {BRIDGE}\n:: {BRIDGE}\n")
        self.chrome = os.path.join(self.dir, "User Data")
        self.add_version("Default", "1.0.105_0", self.KNOWN_JS)
        self.settings = os.path.join(self.dir, "settings.json")
        with open(self.settings, "w", encoding="utf-8") as handle:
            json.dump({"disableRemoteControl": True}, handle)
        self.cache = os.path.join(self.dir, "cache.json")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def add_version(self, profile, version, js):
        folder = os.path.join(self.chrome, profile, "Extensions", self.EXT, version, "assets")
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "service-worker.js"), "w", encoding="utf-8") as handle:
            handle.write(js)

    def check(self, *extra):
        return run_script("check.ps1", "-SkipLive", "-HostsFile", self.hosts, "-ChromeUserData", self.chrome,
                          "-ClaudeSettings", self.settings, "-CacheFile", self.cache, *extra)

    def test_all_good(self):
        r = self.check()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("no unknown remote hosts", r.stdout)
        self.assertIn("Remote Control is disabled", r.stdout)

    def test_new_remote_host_after_an_update_is_flagged(self):
        self.add_version("Profile 3", "1.0.200_0", self.KNOWN_JS + 'const d="wss://relay.claudeusercontent.com";')
        r = self.check()
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("relay.claudeusercontent.com", r.stdout)
        self.assertIn("1.0.200_0", r.stdout)

    def test_missing_block_is_flagged(self):
        with open(self.hosts, "w", encoding="utf-8") as handle:
            handle.write("# nothing\n")
        r = self.check()
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("does NOT block", r.stdout)

    def test_hook_mode_is_silent_when_all_is_well(self):
        r = self.check("-Hook")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "")

    def test_hook_mode_reports_problems_as_json(self):
        self.add_version("Default", "1.0.201_0", 'x="wss://bridge2.claudeusercontent.com"')
        r = self.check("-Hook")
        self.assertEqual(r.returncode, 0)
        out = json.loads(r.stdout)
        self.assertIn("bridge2.claudeusercontent.com", out["systemMessage"])
        self.assertEqual(out["hookSpecificOutput"]["hookEventName"], "SessionStart")

    def test_scanned_versions_are_cached(self):
        self.check()
        with open(self.cache, encoding="utf-8-sig") as handle:
            cached = json.load(handle)
        self.assertIn("1.0.105_0", cached)
        self.assertIn("bridge.claudeusercontent.com", cached["1.0.105_0"])


@unittest.skipUnless(os.name == "nt" and os.path.exists(POWERSHELL), "Windows PowerShell only")
class TabMarkerInstallTest(unittest.TestCase):
    def setUp(self):
        self.claude = tempfile.mkdtemp(prefix=".tmp-marker-", dir=os.path.dirname(os.path.abspath(__file__)))
        self.settings = os.path.join(self.claude, "settings.json")
        shutil.copy(FIXTURE, self.settings)
        self.original = load(self.settings)

    def tearDown(self):
        shutil.rmtree(self.claude, ignore_errors=True)

    def markers(self, settings):
        return [e for e in settings.get("hooks", {}).get("PostToolUse", [])
                if any(h.get("type") == "mcp_tool" and "__claudeTabMarker" in h.get("input", {}).get("function", "")
                       for h in e["hooks"])]

    def test_install_adds_one_hook_and_keeps_everything_else(self):
        r = run_script("tab-marker.ps1", "-ClaudeDir", self.claude)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        after = load(self.settings)
        found = self.markers(after)
        self.assertEqual(len(found), 1)
        hook = found[0]["hooks"][0]
        self.assertEqual((hook["server"], hook["tool"]), ("chrome-devtools", "evaluate_script"))
        self.assertNotIn("pageId", hook["input"])
        self.assertIn("navigate_page", found[0]["matcher"])
        self.assertNotIn("evaluate_script", found[0]["matcher"])  # never re-trigger itself
        rest = copy.deepcopy(after)
        rest["hooks"]["PostToolUse"] = [e for e in rest["hooks"]["PostToolUse"] if e not in found]
        if not rest["hooks"]["PostToolUse"]:
            del rest["hooks"]["PostToolUse"]
        self.assertEqual(rest, self.original)

    def test_reinstall_is_idempotent(self):
        run_script("tab-marker.ps1", "-ClaudeDir", self.claude)
        run_script("tab-marker.ps1", "-ClaudeDir", self.claude)
        self.assertEqual(len(self.markers(load(self.settings))), 1)

    def test_undo_restores_settings(self):
        run_script("tab-marker.ps1", "-ClaudeDir", self.claude)
        r = run_script("tab-marker.ps1", "-ClaudeDir", self.claude, "-Undo")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(load(self.settings), self.original)


if __name__ == "__main__":
    unittest.main()
