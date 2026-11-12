"""Tests for the macOS side of Tether.

The Node parts (settings edits, the check, the connect watch's parsers and rules)
run on every OS. The shell scripts, lsof/ps/codesign and the broker's checks run
on macOS only (CI: macos-latest). Nothing here touches the real /etc/hosts, the
real Claude settings or your LaunchAgents: every test works in a temp folder.
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(ROOT, "scripts")
WATCH = os.path.join(SCRIPTS, "connect-watch.mjs")
CHECK = os.path.join(SCRIPTS, "check.mjs")
SETTINGS_TOOL = os.path.join(SCRIPTS, "lib", "claude-settings.mjs")
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "settings.sample.json")
NODE = shutil.which("node")
MAC = sys.platform == "darwin"
BRIDGE = "bridge.claudeusercontent.com"
ENV = {**os.environ, "TETHER_ALLOW_ANY_PLATFORM": "1"}


def node_eval(code):
    """Run an ES module snippet that imports the connect watch as `w`; returns its JSON output."""
    url = "file:///" + WATCH.replace("\\", "/").lstrip("/")
    src = f"import * as w from {json.dumps(url)};\n{code}"
    r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, encoding="utf-8", timeout=120)
    if r.returncode != 0:
        raise AssertionError(r.stderr)
    return json.loads(r.stdout)


def load(path):
    with open(path, encoding="utf-8-sig") as handle:
        return json.load(handle)


def tempdir(test):
    d = tempfile.mkdtemp(prefix=".tmp-mac-", dir=os.path.dirname(os.path.abspath(__file__)))
    test.addCleanup(shutil.rmtree, d, True)
    return d


# ---------------------------------------------------------------- any OS (Node)

@unittest.skipUnless(NODE, "Node.js needed")
class ClaudeSettingsTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempdir(self)
        shutil.copy(FIXTURE, os.path.join(self.dir, "settings.json"))
        self.original = load(FIXTURE)

    def tool(self, *args):
        r = subprocess.run([NODE, SETTINGS_TOOL, *args, "--claude-dir", self.dir], capture_output=True, text=True, encoding="utf-8", timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def settings(self):
        return load(os.path.join(self.dir, "settings.json"))

    def test_tab_marker_adds_one_hook_and_keeps_everything_else(self):
        self.tool("tab-marker")
        s = self.settings()
        post = s["hooks"]["PostToolUse"]
        self.assertEqual(len(post), 1)
        hook = post[0]["hooks"][0]
        self.assertEqual((hook["type"], hook["server"], hook["tool"]), ("mcp_tool", "chrome-devtools", "evaluate_script"))
        self.assertIn("__claudeTabMarker", hook["input"]["function"])
        self.assertIn("navigate_page", post[0]["matcher"])
        for key in ("theme", "permissions", "env", "modelSettings", "autoMode"):
            self.assertEqual(s[key], self.original[key])
        self.assertEqual(s["hooks"]["PreToolUse"], self.original["hooks"]["PreToolUse"])

    def test_every_tool_is_idempotent_and_undo_restores(self):
        for what in ("tab-marker", "tab-guard", "guard", "check-hook"):
            self.tool(what)
            once = self.settings()
            self.tool(what)
            self.assertEqual(self.settings(), once, what)
            self.tool(what, "--undo")
            self.assertEqual(self.settings(), self.original, what)

    def test_tab_guard_uses_the_full_node_path(self):
        self.tool("tab-guard", "--node", "/opt/homebrew/bin/node")
        s = self.settings()
        pre = [e for e in s["hooks"]["PreToolUse"] if "tab-guard" in json.dumps(e)]
        self.assertEqual(len(pre), 1)
        self.assertEqual(pre[0]["matcher"], "mcp__chrome-devtools__.*")
        self.assertEqual(pre[0]["hooks"][0]["command"], "/opt/homebrew/bin/node")
        self.assertTrue(pre[0]["hooks"][0]["args"][0].endswith("tab-guard.mjs"))
        self.assertEqual(s["hooks"]["PostToolUse"][0]["matcher"], "mcp__chrome-devtools__new_page")

    def test_guard_blocks_on_failure_before_and_confirms_after(self):
        self.tool("guard", "--python", "/usr/bin/python3")
        s = self.settings()
        pre = [e for e in s["hooks"]["PreToolUse"] if "chrome_browser_guard" in json.dumps(e)][0]
        self.assertEqual(pre["matcher"], "mcp__claude-in-chrome__.*")
        self.assertEqual(pre["hooks"][0]["onFailure"], "block")
        post = s["hooks"]["PostToolUse"][0]
        self.assertNotIn("onFailure", post["hooks"][0])

    def test_broken_settings_are_left_alone(self):
        path = os.path.join(self.dir, "settings.json")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("{ not json")
        r = subprocess.run([NODE, SETTINGS_TOOL, "tab-marker", "--claude-dir", self.dir], capture_output=True, text=True, timeout=60)
        self.assertNotEqual(r.returncode, 0)
        with open(path, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "{ not json")

    def test_works_without_a_settings_file(self):
        os.remove(os.path.join(self.dir, "settings.json"))
        self.tool("tab-marker")
        self.assertEqual(list(self.settings()), ["hooks"])
        self.tool("tab-marker", "--undo")
        self.assertEqual(self.settings(), {})


@unittest.skipUnless(NODE, "Node.js needed")
class CheckMjsTest(unittest.TestCase):
    EXT = "fcoeoabgfenejglbffodgkkbkcdhcgfn"

    def setUp(self):
        self.dir = tempdir(self)
        self.hosts = os.path.join(self.dir, "hosts")
        with open(self.hosts, "w") as handle:
            handle.write("127.0.0.1 localhost\n# >>> tether\n0.0.0.0 %s\n:: %s\n# <<< tether\n" % (BRIDGE, BRIDGE))
        self.chrome = os.path.join(self.dir, "Chrome")
        self.add_version("Default", "1.0.105_0", "wss://bridge.claudeusercontent.com/x https://api.anthropic.com")
        self.settings = os.path.join(self.dir, "settings.json")
        with open(self.settings, "w") as handle:
            json.dump({"disableRemoteControl": True}, handle)
        self.cache = os.path.join(self.dir, "cache.json")

    def add_version(self, profile, version, js):
        d = os.path.join(self.chrome, profile, "Extensions", self.EXT, version, "assets")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "service-worker.js"), "w") as handle:
            handle.write(js)

    def run_check(self, *extra):
        return subprocess.run([NODE, CHECK, "--skip-live", "--hosts-file", self.hosts, "--chrome-user-data", self.chrome,
                               "--claude-settings", self.settings, "--cache-file", self.cache, *extra],
                              capture_output=True, text=True, encoding="utf-8", timeout=60)

    def test_all_good(self):
        r = self.run_check()
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("OK    hosts file blocks", r.stdout)
        self.assertIn("1.0.105_0: no unknown remote hosts", r.stdout)
        self.assertIn("Remote Control is disabled", r.stdout)

    def test_new_remote_host_after_an_update_is_flagged(self):
        self.add_version("Profile 1", "1.0.200_0", "new WebSocket('wss://relay.claude-example.com/socket')")
        r = self.run_check()
        self.assertEqual(r.returncode, 1)
        self.assertIn("1.0.200_0 talks to a new remote host: relay.claude-example.com", r.stdout)

    def test_missing_block_is_flagged(self):
        with open(self.hosts, "w") as handle:
            handle.write("127.0.0.1 localhost\n# 0.0.0.0 %s\n" % BRIDGE)
        r = self.run_check()
        self.assertEqual(r.returncode, 1)
        self.assertIn("does NOT block", r.stdout)

    def test_hook_mode_is_silent_when_all_is_well(self):
        r = self.run_check("--hook")
        self.assertEqual((r.returncode, r.stdout.strip()), (0, ""))

    def test_hook_mode_reports_problems_as_json(self):
        os.remove(self.hosts)
        r = self.run_check("--hook")
        self.assertEqual(r.returncode, 0)
        out = json.loads(r.stdout)
        self.assertIn("does NOT block", out["systemMessage"])
        self.assertEqual(out["hookSpecificOutput"]["hookEventName"], "SessionStart")

    def test_scanned_versions_are_cached(self):
        self.run_check()
        self.assertEqual(load(self.cache)["1.0.105_0"], [BRIDGE])  # only ws:// and wss:// hosts count


@unittest.skipUnless(NODE, "Node.js needed")
class ConnectWatchLogicTest(unittest.TestCase):
    # the shape of codesign -dvv on Claude Code from Anthropic's installer (CI saw this one)
    ANTHROPIC = ("Executable=/Users/me/.local/share/claude/versions/2.1.322\nIdentifier=com.anthropic.claude-code\n"
                 "Authority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)\nAuthority=Developer ID Certification Authority\n"
                 "Authority=Apple Root CA\nTeamIdentifier=Q6L2SF6YDW\n")

    def test_codesign_needs_anthropics_developer_id_with_its_own_team(self):
        cases = {
            "anthropic": self.ANTHROPIC,
            "anthropic, with a comma": self.ANTHROPIC.replace("Anthropic PBC", "Anthropic, PBC"),
            "other team": self.ANTHROPIC.replace("TeamIdentifier=Q6L2SF6YDW", "TeamIdentifier=ABCDE12345"),
            "other company": self.ANTHROPIC.replace("Anthropic PBC", "Anthropic Fan Club"),
            "look-alike": self.ANTHROPIC.replace("Anthropic PBC", "Anthropic PBC Tools"),
            "not Apple's chain": self.ANTHROPIC.replace("Authority=Apple Root CA\n", ""),
            "apple": "Authority=Software Signing\nAuthority=Apple Code Signing Certification Authority\nAuthority=Apple Root CA\nTeamIdentifier=not set\n",
            "ad hoc": "Signature=adhoc\nTeamIdentifier=not set\n",
        }
        out = node_eval(f"const c = {json.dumps(cases)}; console.log(JSON.stringify(Object.fromEntries(Object.entries(c).map(([k, v]) => [k, w.parseCodesign(v).anthropic]))));")
        self.assertEqual(out, {"anthropic": True, "anthropic, with a comma": True, "other team": False, "other company": False,
                               "look-alike": False, "not Apple's chain": False, "apple": False, "ad hoc": False})

    def test_lsof_output_gives_both_ends_with_pids(self):
        text = "p501\nf23\nn127.0.0.1:52011->127.0.0.1:9333\np777\nf9\nn127.0.0.1:9333->127.0.0.1:52011\np900\nf4\nn[::1]:6000->[::1]:9222\n"
        out = node_eval(f"console.log(JSON.stringify(w.parseLsof({json.dumps(text)})));")
        self.assertEqual(out[0], {"pid": 501, "localAddr": "127.0.0.1", "localPort": 52011, "remoteAddr": "127.0.0.1", "remotePort": 9333})
        self.assertEqual(out[1]["pid"], 777)
        self.assertEqual(out[2], {"pid": 900, "localAddr": "::1", "localPort": 6000, "remoteAddr": "::1", "remotePort": 9222})

    def test_ps_output_with_spaces_in_paths(self):
        stat = ("  101     1 Thu Nov  3 01:23:45 2026     /Applications/Claude.app/Contents/MacOS/Claude\n"
                "  202   101 Thu Nov 13 09:00:01 2026     /Users/me/Library/Application Support/Claude/claude-code/2.1.3/ab12/claude\n")
        args = "  101 /Applications/Claude.app/Contents/MacOS/Claude\n  202 claude --session-id 11111111-2222-3333-4444-555555555555\n"
        out = node_eval(f"console.log(JSON.stringify([...w.parsePs({json.dumps(stat)}, {json.dumps(args)}).values()]));")
        self.assertEqual([p["pid"] for p in out], [101, 202])
        self.assertEqual(out[1]["ppid"], 101)
        self.assertEqual(out[1]["name"], "claude")
        self.assertTrue(out[1]["exe"].endswith("/ab12/claude"))
        self.assertIn("--session-id", out[1]["args"])
        self.assertLess(out[0]["start"], out[1]["start"])

    def test_the_broker_rule(self):
        tool = {"Kind": "claude-tool", "AppPath": "/Applications/Claude.app", "ClaudePath": "/x/claude"}
        cases = {
            "tool from the app": tool,
            "tool from a terminal": {**tool, "AppPath": "/bin/zsh"},
            "script": {**tool, "Kind": "claude-script"},
            "unknown": {**tool, "Kind": "unknown"},
        }
        out = node_eval(f"const c = {json.dumps(cases)}; console.log(JSON.stringify(Object.fromEntries(Object.entries(c).map(([k, v]) => [k, w.clientAllowed(v, false).Allowed]))));")
        self.assertEqual(out, {"tool from the app": True, "tool from a terminal": False, "script": False, "unknown": False})
        # with signatures on, a path that isn't there is never signed
        out = node_eval(f"console.log(JSON.stringify(w.clientAllowed({json.dumps(tool)}, true)));")
        self.assertFalse(out["Allowed"])
        self.assertIn("isn't signed by Anthropic", out["Reason"])

    def test_desktop_app_bundle_is_found_from_its_helpers(self):
        out = node_eval("console.log(JSON.stringify(['/Applications/Claude.app/Contents/MacOS/Claude', "
                        "'/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper', "
                        "'/Users/me/Applications/Claude.app/Contents/MacOS/Claude', '/usr/local/bin/claude'].map(w.appBundleOf)));")
        self.assertEqual(out, ["/Applications/Claude.app", "/Applications/Claude.app", "/Users/me/Applications/Claude.app", ""])

    def test_session_lookup(self):
        root = os.path.join(tempdir(self), "claude-code-sessions")
        os.makedirs(os.path.join(root, "a", "b"))
        sid, cli = str(uuid.uuid4()), str(uuid.uuid4())
        with open(os.path.join(root, "a", "b", f"local_{sid}.json"), "w", encoding="utf-8") as handle:
            json.dump({"title": "Daytime job apply run", "cwd": "/Users/me/work", "cliSessionId": sid}, handle)
        with open(os.path.join(root, "a", "local_other.json"), "w", encoding="utf-8") as handle:
            json.dump({"title": "سلام session", "cwd": "/Users/me/x", "cliSessionId": cli}, handle)
        r = lambda i: json.loads(subprocess.run([NODE, WATCH, "--lookup-session", i, "--session-roots", root], capture_output=True,
                                                 text=True, encoding="utf-8", env=ENV, timeout=60).stdout)
        self.assertEqual((r(sid)["Title"], r(sid)["Folder"]), ("Daytime job apply run", "/Users/me/work"))
        self.assertEqual(r(cli)["Title"], "سلام session")
        self.assertEqual(r(str(uuid.uuid4()))["Title"], "")

    def test_session_roots_follow_the_claude_code_path(self):
        out = node_eval("console.log(JSON.stringify([w.sessionRootsFor('/Users/me/Library/Application Support/Claude/claude-code/2.1.3/ab/claude'), "
                        "w.sessionRootsFor('/Users/me/ClaudeAccounts/Work/claude-code/2.1.3/ab/claude')]));")
        self.assertEqual(out[0]["roots"][0], "/Users/me/Library/Application Support/Claude/claude-code-sessions")
        self.assertEqual(out[0]["account"], "")
        self.assertEqual(out[1]["roots"][0], "/Users/me/ClaudeAccounts/Work/claude-code-sessions")
        self.assertEqual(out[1]["account"], "Work")


# ---------------------------------------------------------------- macOS only

def bash(script, *args, env=None):
    return subprocess.run(["/bin/bash", os.path.join(ROOT, script), *args], capture_output=True, text=True, encoding="utf-8",
                          timeout=300, env=env or os.environ)


@unittest.skipUnless(MAC, "macOS only")
class BridgeBlockShTest(unittest.TestCase):
    SAMPLE = "##\n# Host Database\n##\n127.0.0.1\tlocalhost\n255.255.255.255\tbroadcasthost\n::1             localhost\n10.0.0.5 nas.local\n"

    def setUp(self):
        self.dir = tempdir(self)
        self.hosts = os.path.join(self.dir, "hosts")
        self.write(self.SAMPLE)

    def write(self, text):
        with open(self.hosts, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)

    def read(self):
        with open(self.hosts, encoding="utf-8", newline="") as handle:
            return handle.read()

    def block(self, *args):
        r = bash("scripts/bridge-block.sh", "--hosts-file", self.hosts, *args)
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        return r

    def test_block_adds_both_sinkholes_and_keeps_existing_lines(self):
        self.block()
        text = self.read()
        self.assertTrue(text.startswith(self.SAMPLE))
        self.assertIn("0.0.0.0 %s\n" % BRIDGE, text)
        self.assertIn(":: %s\n" % BRIDGE, text)

    def test_running_twice_does_not_duplicate(self):
        self.block()
        self.block()
        self.assertEqual(self.read().count("0.0.0.0 %s" % BRIDGE), 1)

    def test_undo_restores_the_original(self):
        self.block()
        self.block("--undo")
        self.assertEqual(self.read(), self.SAMPLE)

    def test_status_reports_both_states(self):
        self.assertIn("Open:", self.block("--status").stdout)
        self.block()
        self.assertIn("Blocked:", self.block("--status").stdout)

    def test_a_commented_out_entry_does_not_count_as_blocked(self):
        self.write(self.SAMPLE + "# 0.0.0.0 %s\n" % BRIDGE)
        self.assertIn("Open:", self.block("--status").stdout)

    def test_file_without_final_newline(self):
        self.write("127.0.0.1 localhost")
        self.block()
        self.assertTrue(self.read().startswith("127.0.0.1 localhost\n# >>> tether"))

    def test_backup_is_written(self):
        self.block()
        self.assertTrue([f for f in os.listdir(self.dir) if f.startswith("hosts.bak-tether-")])


@unittest.skipUnless(MAC, "macOS only")
class ShellInstallersTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempdir(self)
        shutil.copy(FIXTURE, os.path.join(self.dir, "settings.json"))
        self.original = load(FIXTURE)

    def settings(self):
        return load(os.path.join(self.dir, "settings.json"))

    def test_tab_marker_and_tab_guard_install_and_undo(self):
        for script in ("scripts/tab-marker.sh", "scripts/tab-guard.sh"):
            r = bash(script, "--claude-dir", self.dir)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertNotEqual(self.settings(), self.original)
            r = bash(script, "--undo", "--claude-dir", self.dir)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(self.settings(), self.original, script)

    def test_guard_install_passes_its_self_test_and_uninstalls(self):
        env = {**os.environ, "TETHER_PYTHON": sys.executable}
        r = bash("scripts/guard-install.sh", "--device-id", "11111111-2222-3333-4444-555555555555", "--claude-dir", self.dir, env=env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(r.stdout.count("PASS"), 4, r.stdout)
        self.assertTrue(os.path.exists(os.path.join(self.dir, "hooks", "chrome_browser_guard.py")))
        r = bash("scripts/guard-uninstall.sh", "--claude-dir", self.dir)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.settings(), self.original)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "hooks", "chrome_browser_guard.py")))

    def test_malformed_device_id_is_refused_and_nothing_changes(self):
        r = bash("scripts/guard-install.sh", "--device-id", "not-an-id", "--claude-dir", self.dir)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.settings(), self.original)

    def test_launch_agent_plist_is_valid(self):
        agents = os.path.join(self.dir, "LaunchAgents")
        script = ('source scripts/lib/common.sh; NODE=/usr/bin/true; '
                  'write_agent broker "$1/broker.out.log" /usr/bin/true "/path with space/tether-broker.mjs"; agent_plist broker')
        r = subprocess.run(["/bin/bash", "-c", script, "x", self.dir], cwd=ROOT, capture_output=True, text=True,
                           env={**os.environ, "TETHER_LAUNCH_AGENTS": agents}, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        plist = r.stdout.strip()
        self.assertTrue(plist.endswith("io.github.shakaibarsalan.tether.broker.plist"))
        lint = subprocess.run(["/usr/bin/plutil", "-lint", plist], capture_output=True, text=True)
        self.assertEqual(lint.returncode, 0, lint.stdout)
        data = json.loads(subprocess.run(["/usr/bin/plutil", "-convert", "json", "-o", "-", plist], capture_output=True, text=True).stdout)
        self.assertEqual(data["ProgramArguments"], ["/usr/bin/true", "/path with space/tether-broker.mjs"])
        self.assertTrue(data["RunAtLoad"])
        self.assertEqual(data["KeepAlive"], {"SuccessfulExit": False})

    def test_check_sh_hook_mode(self):
        hosts = os.path.join(self.dir, "hosts")
        with open(hosts, "w") as handle:
            handle.write("127.0.0.1 localhost\n")
        r = bash("scripts/check.sh", "--hook", "--skip-live", "--hosts-file", hosts, "--chrome-user-data", self.dir,
                 "--claude-settings", os.path.join(self.dir, "settings.json"), "--cache-file", os.path.join(self.dir, "c.json"))
        self.assertEqual(r.returncode, 0)
        self.assertIn("does NOT block", json.loads(r.stdout)["systemMessage"])


def clone(src, dst):
    """A copy of a program under another name (APFS clone when it can, so it takes no space)."""
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if subprocess.run(["/bin/cp", "-c", src, dst], capture_output=True).returncode != 0:
        shutil.copy2(src, dst)
    os.chmod(dst, 0o755)


@unittest.skipUnless(MAC and NODE, "macOS only")
class LiveBase(unittest.TestCase):
    """Real processes and real sockets: the same lookups the broker and the watch make."""

    def setUp(self):
        self.dir = tempdir(self)
        self.server = socket.socket()
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(8)
        self.port = self.server.getsockname()[1]
        self.addCleanup(self.server.close)

    def verify(self, client_port, *extra):
        r = subprocess.run([NODE, WATCH, "--verify-client-port", str(client_port), "--server-port", str(self.port), *extra],
                           capture_output=True, text=True, encoding="utf-8", timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def fake_session(self, app_parent, via_shell=False):
        """chrome-devtools-mcp <- a program called claude (in claude-code/<version>/<hash>/) <- [/bin/sh <-] a Claude.app, or this test."""
        base = os.path.join(self.dir, "Claude Data")
        claude = os.path.join(base, "claude-code", "9.9.9", "abc123", "claude")
        clone(NODE, claude)
        sid = str(uuid.uuid4())
        sessions = os.path.join(base, "claude-code-sessions", "acct", "org")
        os.makedirs(sessions)
        with open(os.path.join(sessions, f"local_{sid}.json"), "w", encoding="utf-8") as handle:
            json.dump({"title": "Fake browser task", "cwd": "/Users/me/project", "cliSessionId": sid}, handle)
        mcp = os.path.join(ROOT, "tests", "fixtures", "chrome-devtools-mcp", "fake-client.mjs")
        launcher = os.path.join(self.dir, "launch-claude.mjs")
        with open(launcher, "w") as handle:
            handle.write("import { spawn } from 'node:child_process';\n"
                         "const c = spawn(process.env.REAL_NODE, [process.env.MCP, process.env.PORT], { stdio: ['ignore', 'inherit', 'inherit'] });\n"
                         "setTimeout(() => {}, 60000);\n")
        env = {**os.environ, "REAL_NODE": NODE, "MCP": mcp, "PORT": str(self.port)}
        cmd = [claude, launcher, "--session-id", sid]
        if app_parent:
            app = os.path.join(self.dir, "Claude.app", "Contents", "MacOS", "Claude")
            clone(NODE, app)
            app_launcher = os.path.join(self.dir, "launch-app.mjs")
            if via_shell:
                # like an app that starts Claude Code through a shell ("; true" so sh can't just exec it)
                line = '"%s" "%s" --session-id %s; true' % (claude, launcher, sid)
                start = "spawn('/bin/sh', ['-c', %s]" % json.dumps(line)
            else:
                start = "spawn(%s, [%s, '--session-id', %s]" % (json.dumps(claude), json.dumps(launcher), json.dumps(sid))
            with open(app_launcher, "w") as handle:
                handle.write("import { spawn } from 'node:child_process';\n"
                             + start + ", { stdio: ['ignore', 'inherit', 'inherit'] });\n"
                             "setTimeout(() => {}, 60000);\n")
            cmd = [app, app_launcher]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True, env=env, start_new_session=True)
        self.addCleanup(lambda: (os.killpg(proc.pid, 15), proc.wait(), proc.stdout.close()))
        client_port = int(proc.stdout.readline())
        return client_port, claude


class LiveProcessTest(LiveBase):
    def test_a_plain_program_is_refused(self):
        client = socket.create_connection(("127.0.0.1", self.port))
        self.addCleanup(client.close)
        answer = self.verify(client.getsockname()[1])
        self.assertFalse(answer["Allowed"], answer)
        self.assertEqual(answer["ProcessId"], os.getpid())
        self.assertEqual(answer["Kind"], "unknown")

    def test_claude_tool_from_a_terminal_is_named_but_refused(self):
        client_port, claude = self.fake_session(app_parent=False)
        answer = self.verify(client_port, "--skip-signatures")
        self.assertEqual(answer["Kind"], "claude-tool", answer)
        self.assertEqual(answer["Title"], "Fake browser task")
        self.assertEqual(answer["Folder"], "/Users/me/project")
        self.assertEqual(os.path.realpath(answer["ClaudePath"]), os.path.realpath(claude))
        self.assertFalse(answer["Allowed"])
        self.assertIn("not started by the Claude desktop app", answer["Reason"])

    def test_claude_tool_from_a_claude_app_needs_anthropics_signatures(self):
        client_port, _ = self.fake_session(app_parent=True)
        answer = self.verify(client_port, "--skip-signatures")
        self.assertTrue(answer["AppPath"].endswith("/Claude.app"), answer)
        self.assertTrue(answer["Allowed"], answer)  # the rule itself passes...
        answer = self.verify(client_port)           # ...but a copy of node isn't signed by Anthropic
        self.assertFalse(answer["Allowed"])
        self.assertIn("isn't signed by Anthropic", answer["Reason"])

    def test_a_shell_between_the_app_and_claude_code_is_looked_past(self):
        client_port, _ = self.fake_session(app_parent=True, via_shell=True)
        answer = self.verify(client_port, "--skip-signatures")
        self.assertIn("sh", answer["Chain"], answer)
        self.assertTrue(answer["AppPath"].endswith("/Claude.app"), answer)
        self.assertTrue(answer["Allowed"], answer)

    def test_apple_signed_program_is_not_anthropic(self):
        out = json.loads(subprocess.run([NODE, WATCH, "--check-signature", "/bin/ls"], capture_output=True, text=True, timeout=120).stdout)
        self.assertFalse(out["Signed"])
        self.assertIn("Software Signing", out["Signer"])

    def test_claude_code_binary_is_signed_by_anthropic(self):
        candidates = [os.environ.get("TETHER_TEST_CLAUDE_BINARY", ""), shutil.which("claude") or "",
                      os.path.expanduser("~/.local/bin/claude")]
        found = [os.path.realpath(c) for c in candidates if c and os.path.exists(c)]
        found = [c for c in found if subprocess.run(["/usr/bin/file", c], capture_output=True, text=True).stdout.find("Mach-O") >= 0]
        if not found:
            self.skipTest("no native Claude Code binary here")
        out = json.loads(subprocess.run([NODE, WATCH, "--check-signature", found[0]], capture_output=True, text=True, timeout=600).stdout)
        self.assertTrue(out["Signed"], out)


@unittest.skipUnless(MAC and NODE and os.path.isdir(os.path.join(ROOT, "broker", "node_modules", "ws")), "macOS with broker/node_modules")
class BrokerOnMacTest(LiveBase):
    """The broker's own check on macOS: its connect-watch.mjs --serve worker."""

    def start_broker(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        self.log = os.path.join(self.dir, "broker.log")
        b = subprocess.Popen([NODE, os.path.join(ROOT, "broker", "tether-broker.mjs"), "--port", str(port), "--lazy", "--no-notify",
                              "--log", self.log, "--chrome-user-data", self.dir], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: (b.kill(), b.wait()))
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=1).close()
                return port
            except OSError:
                time.sleep(0.1)
        self.fail("broker did not start")

    def handshake(self, port):
        c = socket.create_connection(("127.0.0.1", port), timeout=60)
        c.sendall(("GET /devtools/browser/tether HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n" % port).encode())
        reply = c.recv(200).decode(errors="replace")
        c.close()
        return reply.split("\r\n")[0]

    def test_a_plain_program_gets_403(self):
        port = self.start_broker()
        self.assertIn("403", self.handshake(port))
        with open(self.log) as handle:
            log = handle.read()
        self.assertIn("refused", log)
        self.assertIn(f"pid {os.getpid()}", log)

    def test_fake_claude_app_is_refused_for_its_signature(self):
        self.port = self.start_broker()
        self.fake_session(app_parent=True)
        for _ in range(300):
            with open(self.log) as handle:
                log = handle.read()
            if "isn't signed by Anthropic" in log:
                break
            time.sleep(0.2)
        self.assertIn("Claude session 'Fake browser task'", log)
        self.assertIn("isn't signed by Anthropic", log)


if __name__ == "__main__":
    unittest.main()
