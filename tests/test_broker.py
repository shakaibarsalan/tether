"""Static checks for the Tether broker, plus its yes/no check on a real local
connection. The broker replaces Chrome's per-session "Allow?" for Claude Code,
so these fail if a change quietly lets more in: listening beyond 127.0.0.1,
accepting browser pages, dropping the signature check, unpinning its only
dependency, or no longer blocking commands that close Chrome.

The full test against a throwaway Chrome is tests/broker-e2e.mjs."""

import hashlib
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
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

    def test_the_quick_check_has_a_worker_to_itself(self):
        # "who is this?" must not wait behind signature checks, names or notifications
        self.assertIn("check ${remotePort} ${pid}", self.src)
        self.assertEqual(self.src.count("worker.ask("), 1)  # the check only
        for request in ("`sig ", "`session ", "`toast ", "'paths'"):
            self.assertIn("slowWorker.ask(" + request, self.src)

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

    @unittest.skipUnless(os.name == "nt" and os.path.exists(POWERSHELL), "Windows PowerShell only")
    def test_the_broker_worker_answers_verify_and_check(self):
        # The broker's long-running worker (connect-watch.ps1 -Serve), on real connections.
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        server.listen(4)
        port = server.getsockname()[1]
        client = socket.create_connection(("127.0.0.1", port))
        other = socket.create_connection(("127.0.0.1", port))
        worker = subprocess.Popen([POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", WATCH,
                                   "-Serve", "-ServerPort", str(port)],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8")
        ask = lambda line: (worker.stdin.write(line + "\n"), worker.stdin.flush(), json.loads(worker.stdout.readline()))[2]
        try:
            # finds the owner itself (netstat)
            v = ask(f"verify {client.getsockname()[1]}")
            self.assertEqual(v["ProcessId"], os.getpid(), v)
            self.assertFalse(v["Allowed"], v)
            # the broker passes the owner it found: no second lookup, no session title
            c = ask(f"check {other.getsockname()[1]} {os.getpid()}")
            self.assertEqual(c["ProcessId"], os.getpid(), c)
            self.assertFalse(c["Allowed"], c)
            self.assertEqual(c["Title"], "", c)
            # a port nobody uses: nothing found, no
            gone = ask("verify 1")
            self.assertFalse(gone["Allowed"], gone)
            self.assertEqual(gone["Reason"], "connection not found", gone)
        finally:
            worker.stdin.close()
            worker.wait(timeout=60)
            worker.stdout.close()
            client.close()
            other.close()
            server.close()


NODE = shutil.which("node")


@unittest.skipUnless(os.name == "nt" and NODE and os.path.isdir(os.path.join(BROKER, "node_modules", "ws")),
                     "Windows with broker/node_modules")
class BrokerOnWindowsTest(unittest.TestCase):
    """The whole broker on a test port: netstat finds the client, the worker's
    quick "check" decides. --lazy: it never connects to Chrome, so no Allow."""

    def test_a_plain_program_gets_403_quickly(self):
        tmp = tempfile.mkdtemp(prefix="tether-broker-")
        self.addCleanup(shutil.rmtree, tmp, True)
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        log = os.path.join(tmp, "broker.log")
        b = subprocess.Popen([NODE, os.path.join(BROKER, "tether-broker.mjs"), "--port", str(port), "--lazy", "--no-notify",
                              "--log", log, "--chrome-user-data", tmp], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: (b.kill(), b.wait()))
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=1).close()
                break
            except OSError:
                time.sleep(0.1)
        start = time.time()
        c = socket.create_connection(("127.0.0.1", port), timeout=90)
        c.sendall(("GET /devtools/browser/tether HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n" % port).encode())
        reply = c.recv(200).decode(errors="replace")
        took = time.time() - start
        c.close()
        self.assertIn("403", reply.split("\r\n")[0])
        self.assertLess(took, 45, f"the check took {took:.1f} s")
        text = ""
        for _ in range(100):
            with open(log, encoding="utf-8") as handle:
                text = handle.read()
            if "refused" in text:
                break
            time.sleep(0.2)
        self.assertIn(f"pid {os.getpid()}", text)
        self.assertNotIn("timed out", text)


@unittest.skipUnless(NODE and os.path.isdir(os.path.join(BROKER, "node_modules", "ws")), "needs node and broker/node_modules")
class BrokerFocusTest(unittest.TestCase):
    """Claude never pulls Chrome to the front (on a Mac that takes you out of
    the app you're in). tests/broker-focus.mjs puts a fake Chrome behind the
    broker and checks what the broker sends it."""

    def test_never_brings_chrome_to_the_front(self):
        r = subprocess.run([NODE, os.path.join(ROOT, "tests", "broker-focus.mjs")],
                           capture_output=True, text=True, encoding="utf-8", timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertNotIn("FAIL", r.stdout)

    def test_tabs_open_in_the_profile_with_the_extension_and_survive_a_restart(self):
        # tests/broker-profile.mjs: a fake Chrome with two profiles, and a broker restarted in between
        r = subprocess.run([NODE, os.path.join(ROOT, "tests", "broker-profile.mjs")],
                           capture_output=True, text=True, encoding="utf-8", timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertNotIn("FAIL", r.stdout)

    def test_extension_id_is_the_one_chrome_gives_the_unpacked_folder(self):
        # seen on Windows: C:\Drive\tether\extension loaded unpacked is gnjnmlhgeobmcdiceboflhdfehlmjlnd
        digest = hashlib.sha256("C:\\Drive\\tether\\extension".encode("utf-16-le")).hexdigest()[:32]
        self.assertEqual("".join(chr(ord("a") + int(c, 16)) for c in digest), "gnjnmlhgeobmcdiceboflhdfehlmjlnd")
        src = read(os.path.join(ROOT, "scripts", "lib", "chrome-profiles.mjs"))
        self.assertIn("platform === 'win32' ? 'utf16le' : 'utf8'", src)
        self.assertIn("slice(0, 32).replace(/./g, (c) => String.fromCharCode(97 + parseInt(c, 16)))", src)
        self.assertIn("import { tetherExtensionIds } from '../scripts/lib/chrome-profiles.mjs'", read(os.path.join(BROKER, "tether-broker.mjs")))


if __name__ == "__main__":
    unittest.main()
