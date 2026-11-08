"""Keep Claude in Chrome on your own browser, and nobody else's.

A Claude Code PreToolUse and PostToolUse hook for the mcp__claude-in-chrome__*
tools. Every Chrome with the Claude extension signed in to your account shows
up in list_connected_browsers, from any computer, and select_browser can pick
any of them without a prompt in that browser. This guard makes Claude Code on
this computer refuse every browser except the ones you list.

Rules:
  * Only device IDs listed in chrome-allowed-devices.txt (next to this file)
    may be controlled.
  * switch_browser is always refused: it sends a connect request to every
    browser on the account.
  * select_browser is refused for any device not in the allowed list.
  * Every other browser tool is refused until list_connected_browsers has
    shown, in this session, that the browser in use is an allowed one. That
    check stays valid for VERIFY_TTL seconds, and choosing a browser again
    resets it.

It fails closed: if anything goes wrong while checking, the browser action is
refused rather than let through.

This guards one direction only: it stops YOUR Claude from driving someone
else's browser. To stop other computers from driving YOUR browser, block the
bridge (scripts/bridge-block.ps1).
"""

import json
import os
import re
import sys
import time

HOOK_DIR = os.path.dirname(os.path.abspath(__file__))
ALLOWED_FILE = os.path.join(HOOK_DIR, "chrome-allowed-devices.txt")
STATE_DIR = os.path.join(HOOK_DIR, "chrome-guard-state")
PREFIX = "mcp__claude-in-chrome__"
VERIFY_TTL = 30 * 60  # seconds a confirmed check stays valid
STATE_MAX_AGE = 24 * 60 * 60  # old session files are pruned after this


def allowed_ids() -> set:
    ids = set()
    try:
        with open(ALLOWED_FILE, encoding="utf-8") as handle:
            for line in handle:
                token = line.split("#", 1)[0].strip()
                if token:
                    ids.add(token.split()[0].lower())
    except OSError:
        pass
    return ids


def state_file(session_id: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", session_id or "no-session")
    return os.path.join(STATE_DIR, safe)


def is_verified(session_id: str, ids: set) -> bool:
    path = state_file(session_id)
    try:
        if time.time() - os.path.getmtime(path) > VERIFY_TTL:
            return False
        with open(path, encoding="utf-8") as handle:
            return handle.read().strip().lower() in ids
    except OSError:
        return False


def mark_verified(session_id: str, device_id: str) -> None:
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(state_file(session_id), "w", encoding="utf-8") as handle:
        handle.write(device_id.lower())


def clear(session_id: str) -> None:
    try:
        os.remove(state_file(session_id))
    except OSError:
        pass


def prune_old_state() -> None:
    try:
        now = time.time()
        for name in os.listdir(STATE_DIR):
            path = os.path.join(STATE_DIR, name)
            if now - os.path.getmtime(path) > STATE_MAX_AGE:
                os.remove(path)
    except OSError:
        pass


def deny(reason: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


def short_name(tool_name: str) -> str:
    name = tool_name or ""
    return name[len(PREFIX):] if name.startswith(PREFIX) else name


def how_to_unlock(ids: set) -> str:
    listed = ", ".join(sorted(ids)) or "(none configured)"
    return (
        "Claude in Chrome on this computer is locked to its owner's own browser "
        f"(allowed deviceId: {listed}). Call list_connected_browsers on its own. "
        "If the allowed device is listed but not marked inUse, call "
        "select_browser with that deviceId, then list_connected_browsers again "
        "so this guard can confirm it. If the allowed device is not listed, "
        "stop and ask the user. Never use any other browser: other people's "
        "browsers can be connected to the same Claude account."
    )


def pre(payload: dict) -> None:
    ids = allowed_ids()
    name = short_name(payload.get("tool_name"))
    tool_input = payload.get("tool_input") or {}
    session_id = payload.get("session_id") or ""

    if name == "list_connected_browsers":
        return

    if name == "switch_browser":
        deny(
            "Blocked: switch_browser sends a connect request to every Chrome "
            "on this Claude account, including other people's. "
            + how_to_unlock(ids)
        )

    if name == "select_browser":
        device = str(tool_input.get("deviceId") or "").strip().lower()
        if device and device in ids:
            return
        deny(f"Blocked: device '{device or '?'}' is not the owner's browser. " + how_to_unlock(ids))

    if name == "browser_batch":
        for action in tool_input.get("actions") or []:
            inner = short_name((action or {}).get("name"))
            if inner in ("switch_browser", "select_browser"):
                deny(
                    "Blocked: choose the browser with select_browser and "
                    "list_connected_browsers on their own, never inside "
                    "browser_batch. " + how_to_unlock(ids)
                )

    if not is_verified(session_id, ids):
        deny("Blocked: the browser in use has not been confirmed. " + how_to_unlock(ids))


def collect_strings(value, out: list) -> None:
    if isinstance(value, str):
        out.append(value)
    elif isinstance(value, dict):
        for item in value.values():
            collect_strings(item, out)
    elif isinstance(value, list):
        for item in value:
            collect_strings(item, out)


def browsers_in(value) -> list:
    """Find the browser list in a list_connected_browsers response."""
    if isinstance(value, list) and value and all(
        isinstance(item, dict) and "deviceId" in item for item in value
    ):
        return value
    strings = []
    collect_strings(value, strings)
    for text in strings:
        for candidate in (text, *re.findall(r"\[.*\]", text, re.DOTALL)):
            try:
                parsed = json.loads(candidate)
            except ValueError:
                continue
            if isinstance(parsed, list) and all(
                isinstance(item, dict) and "deviceId" in item for item in parsed
            ):
                return parsed
    return []


def post(payload: dict) -> None:
    name = short_name(payload.get("tool_name"))
    session_id = payload.get("session_id") or ""

    if name == "select_browser":
        clear(session_id)  # must be confirmed again by list_connected_browsers
        return

    if name == "list_connected_browsers":
        ids = allowed_ids()
        in_use = [
            str(b.get("deviceId") or "").lower()
            for b in browsers_in(payload.get("tool_response"))
            if b.get("inUse") is True
        ]
        if len(in_use) == 1 and in_use[0] in ids:
            mark_verified(session_id, in_use[0])
        else:
            clear(session_id)
        prune_old_state()


def main() -> None:
    try:
        # Raw bytes as UTF-8: Windows' default code page would garble or
        # reject non-English text (Urdu, for example) in a tool's input.
        raw = sys.stdin.buffer.read().decode("utf-8-sig", errors="replace")
        payload = json.loads(raw)
    except Exception:
        payload = None

    event = (payload or {}).get("hook_event_name") or ""

    if event == "PostToolUse":
        try:
            post(payload)
        except Exception:
            pass  # a failed check only means the browser stays locked
        return

    # PreToolUse, or anything unexpected: decide, and refuse on any error.
    try:
        if payload is None:
            raise ValueError("unreadable hook input")
        pre(payload)
    except SystemExit:
        raise
    except Exception as error:  # fail closed
        deny(f"Blocked: the Chrome browser guard could not check this call ({error}).")


if __name__ == "__main__":
    main()
