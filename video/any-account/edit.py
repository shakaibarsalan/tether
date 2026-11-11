"""Cut the four Veo clips to the voice-over, add the text layer, mix the sound.

    python video/any-account/voiceover.py        # build/vo.wav + timeline.json
    node   video/any-account/overlay-render.mjs  # build/overlay/f00000.png ...
    python video/any-account/edit.py             # tether-any-account.mp4

Pass 1 joins the clips: each shot runs from the start of its line to the start
of the next one, with a 0.6 s cross-fade at every cut. A shot that needs more
time than its 8 s clip is slowed down slightly. Pass 2 lays the transparent text
layer on top and mixes the voice with the clips' own ambient sound.
"""

import json
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
CLIPS = os.path.join(HERE, "clips")
BUILD = os.path.join(HERE, "build")
OUT = os.path.join(HERE, "tether-any-account.mp4")
SHOTS = ["shot1.mp4", "shot2.mp4", "shot3.mp4", "shot4.mp4"]
FADE = 0.6
CLIP_LEN = 8.0
AMBIENT = 0.22
W, H, FPS = 1920, 1080, 30


def segments(t):
    total = t["total"]
    cuts = [0.0] + [line["start"] for line in t["lines"][1:]] + [total]
    out = []
    for i in range(len(SHOTS)):
        start = cuts[i] - (FADE / 2 if i else 0)
        end = cuts[i + 1] + (FADE / 2 if i < len(SHOTS) - 1 else 0)
        length = end - start
        out.append((start, length, max(1.0, length / CLIP_LEN)))
    return cuts, out


def run(cmd):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *cmd], check=True)


def main():
    t = json.load(open(os.path.join(HERE, "timeline.json"), encoding="utf-8"))
    total = t["total"]
    cuts, segs = segments(t)
    clip_inputs = [x for name in SHOTS for x in ("-i", os.path.join(CLIPS, name))]

    # pass 1: picture only
    vf, last = [], "v0"
    for i, (_, length, stretch) in enumerate(segs):
        vf.append(f"[{i}:v]setpts={stretch:.4f}*(PTS-STARTPTS),fps={FPS},scale={W}:{H}:flags=lanczos,"
                  f"trim=duration={length:.3f},setpts=PTS-STARTPTS,format=yuv420p[v{i}]")
    for i in range(1, len(SHOTS)):
        vf.append(f"[{last}][v{i}]xfade=transition=fade:duration={FADE}:offset={cuts[i] - FADE / 2:.3f}[x{i}]")
        last = f"x{i}"
    base = os.path.join(BUILD, "base.mp4")
    run([*clip_inputs, "-filter_complex", ";".join(vf), "-map", f"[{last}]", "-t", f"{total:.3f}",
         "-c:v", "libx264", "-preset", "medium", "-crf", "12", "-pix_fmt", "yuv420p", base])

    # pass 2: text layer + sound
    n = len(SHOTS)
    af = []
    for i, (start, length, stretch) in enumerate(segs):
        delay = int(start * 1000)
        af.append(f"[{2 + i}:a]atempo={1 / stretch:.4f},atrim=duration={length:.3f},asetpts=PTS-STARTPTS,"
                  f"afade=t=in:d=0.3,afade=t=out:st={max(0, length - 0.4):.3f}:d=0.4,"
                  f"volume={AMBIENT},adelay={delay}|{delay}[a{i}]")
    graph = ";".join([
        "[0:v][1:v]overlay=0:0:format=auto,format=yuv420p[vout]",
        *af,
        f"{''.join(f'[a{i}]' for i in range(n))}[{2 + n}:a]amix=inputs={n + 1}:normalize=0,"
        f"atrim=duration={total:.3f},loudnorm=I=-14:TP=-1.5:LRA=11[aout]",
    ])
    run(["-i", base, "-framerate", str(FPS), "-i", os.path.join(BUILD, "overlay", "f%05d.png"),
         *clip_inputs, "-i", os.path.join(BUILD, "vo.wav"),
         "-filter_complex", graph, "-map", "[vout]", "-map", "[aout]", "-t", f"{total:.3f}", "-r", str(FPS),
         "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", OUT])
    print("wrote", OUT)


if __name__ == "__main__":
    main()
