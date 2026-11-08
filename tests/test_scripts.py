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


if __name__ == "__main__":
    unittest.main()
