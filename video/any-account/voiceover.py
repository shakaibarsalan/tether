"""Voice-over for the "any Claude account" feature video (Kokoro, am_liam).

    python video/any-account/voiceover.py

Writes build/vo.wav (git-ignored) and timeline.json: when each line starts and
ends. edit.py cuts the Veo clips to these times.
"""

import json
import os

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "build")
CACHE = os.path.join(os.path.expanduser("~"), ".cache", "hyperframes", "tts")
MODEL = os.environ.get("KOKORO_MODEL", os.path.join(CACHE, "models", "kokoro-v1.0.onnx"))
VOICES = os.environ.get("KOKORO_VOICES", os.path.join(CACHE, "voices", "voices-v1.0.bin"))
VOICE, SPEED, SR = "am_liam", 0.97, 24000

# One line per shot. HOLD gives a shot extra time after its line.
LINES = [
    "New in Tether. One browser, for every Claude account.",
    "Before, Claude could only use your browser from one account. Switch accounts, and you sign in all over again.",
    "Now, any Claude account on your laptop uses the same Chrome, with all your logins. No more signing in again.",
    "Tether. Free and open source, on GitHub.",
]
LEAD_IN, GAP, TAIL = 0.6, 0.35, 3.5
HOLD = {}  # no pauses: every shot ends when its line ends


def main():
    os.makedirs(BUILD, exist_ok=True)
    kokoro = Kokoro(MODEL, VOICES)
    clips, starts, cursor = [], [], LEAD_IN
    for i, line in enumerate(LINES):
        samples, sr = kokoro.create(line, voice=VOICE, speed=SPEED, lang="en-us")
        assert sr == SR
        samples = np.asarray(samples, dtype=np.float32)
        starts.append(cursor)
        clips.append(samples)
        cursor += len(samples) / SR + GAP + HOLD.get(i, 0)
    total = cursor - GAP + TAIL
    track = np.zeros(int(SR * total) + SR, dtype=np.float32)
    for s, c in zip(starts, clips):
        track[int(s * SR):int(s * SR) + len(c)] += c
    track *= 0.89 / (np.max(np.abs(track)) or 1.0)
    sf.write(os.path.join(BUILD, "vo.wav"), track[: int(SR * total)], SR)
    timeline = {"total": round(total, 2), "lines": [
        {"text": t, "start": round(s, 2), "end": round(s + len(c) / SR, 2)} for t, s, c in zip(LINES, starts, clips)]}
    with open(os.path.join(HERE, "timeline.json"), "w", encoding="utf-8") as f:
        json.dump(timeline, f, indent=2)
    print(json.dumps(timeline, indent=2))


if __name__ == "__main__":
    main()
