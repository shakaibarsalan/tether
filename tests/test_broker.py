"""Static checks for the Tether broker, plus its yes/no check on a real local
connection. The broker replaces Chrome's per-session "Allow?" for Claude Code,
so these fail if a change quietly lets more in: listening beyond 127.0.0.1,
accepting browser pages, dropping the signature check, unpinning its only
dependency, or no longer blocking commands that close Chrome.

The full test against a throwaway Chrome is tests/broker-e2e.mjs."""

import json
import os
import socket
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BROKER = os.path.join(ROOT, "broker")
WATCH = os.path.join(ROOT, "scripts", "connect-watch.ps1")
POWERSHELL = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")


def read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


class BrokerSourceTest(unittest.TestCase):
    def setUp(self):
        self.src = read(os.path.join(BROKER, "tether-broker.mjs"))

    def test_listens_on_loopback_only(self):
        self.assertIn("const HOST = '127.0.0.1';", self.src)
        self.assertIn("server.listen(PORT, HOST", self.src)

    def test_refuses_browser_pages_and_dns_rebinding(self):
        self.assertIn("req.headers.origin", self.src)
        self.assertIn("hostOk(req)", self.src)

    def test_checks_every_client_unless_the_test_flag_is_set(self):
        self.assertIn("if (!ALLOW_ANY) {", self.src)
        self.assertIn("'insecure-allow-any-client'", self.src)
        self.assertIn("signedByAnthropic(v.ClaudePath)", self.src)
        self.assertIn("signedByAnthropic(v.AppPath)", self.src)

    def test_blocks_commands_that_close_chrome_or_leak_the_protocol(self):
        for method in ("Browser.close", "Browser.crash", "Target.exposeDevToolsProtocol"):
            self.assertIn(f"'{method}'", self.src)

    def test_each_client_gets_its_own_browser_session(self):
        self.assertIn("Target.attachToBrowserTarget", self.src)
        self.assertIn("'Session with given id not found.'", self.src)

    def test_only_dependency_is_pinned(self):
        with open(os.path.join(BROKER, "package.json"), encoding="utf-8") as handle:
            deps = json.load(handle)["dependencies"]
        self.assertEqual(list(deps), ["ws"])
        self.assertRegex(deps["ws"], r"^\d+\.\d+\.\d+$")
        with open(os.path.join(BROKER, "package-lock.json"), encoding="utf-8") as handle:
            lock = json.load(handle)
        self.assertEqual(lock["packages"]["node_modules/ws"]["version"], deps["ws"])


class VerifyRuleTest(unittest.TestCase):
    def test_rule_needs_desktop_app_and_two_anthropic_signatures(self):
        src = read(WATCH)
        self.assertIn("$Info.Kind -ne 'claude-tool'", src)
        self.assertIn(r"\\WindowsApps\\Claude_[^\\]+\\app\\claude\.exe$", src)
        self.assertIn('O="?Anthropic, PBC"?', src)

    @unittest.skipUnless(os.name == "nt" and os.path.exists(POWERSHELL), "Windows PowerShell only")
    def test_a_plain_program_is_refused(self):
        # A real TCP connection from this test process: not chrome-devtools-mcp, so no.
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        port = server.getsockname()[1]
        client = socket.create_connection(("127.0.0.1", port))
        try:
            r = subprocess.run([POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", WATCH,
                                "-VerifyClientPort", str(client.getsockname()[1]), "-ServerPort", str(port)],
                               capture_output=True, text=True, encoding="utf-8", timeout=120)
            answer = json.loads(r.stdout)
            self.assertFalse(answer["Allowed"], answer)
            self.assertEqual(answer["ProcessId"], os.getpid())
            self.assertIn(answer["Kind"], ("unknown", "claude-script"))
        finally:
            client.close()
            server.close()


if __name__ == "__main__":
    unittest.main()
