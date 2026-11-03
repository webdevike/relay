#!/usr/bin/env python3
"""Cuts build/morning-*.mov (tools/record-morning.sh) into proof/morning-demo.mp4: each scene trimmed
and cropped around the action, under the same header bar as the assistant proof (app, question, who
answered), with the assistants' recorded voices. 1280x720, phone friendly. Also writes the stills
proof/morning-still-*.png from the cut (STILLS: scene, second into that scene)."""
import importlib.util
import os
import subprocess
import sys

sys.dont_write_bytecode = True  # loading assist-cut.py below leaves no tools/__pycache__

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("assist_cut", os.path.join(ROOT, "tools/assist-cut.py"))
cut = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cut)
W, H, BAR = cut.W, cut.H, cut.BAR
NOVA, ASTRA = cut.NOVA, cut.ASTRA

# Linear at 1:1 around the issue's text, the cursor's spot and the properties column, legible on a phone.
LINEAR = "1280:720:1950:50"
# Opening by key: the title Astra points at and her caption sit at Linear's right edge.
LINEAR_RIGHT = "1280:720:2277:30"
BLENDER = "1440:810:0:30"
# The lesson list sits at the display's right edge, beside Blender: it is inset, live from the same frame,
# into the top-right corner of the Blender crop.
CHECKLIST = "350:200:3482:36"
# Everything plays this much faster (pitch kept), so the six asks fit about 75 s.
SPEED = 1.07
# name, crop w:h:x:y on the 3840x1080 display, inset crop or None, kept (start, end) seconds of the raw
# scene (jump cuts over the waits), app, question, who, why
SCENES = [
    ("1-bevel", BLENDER, None, [(1.0, 11.8)], "Blender", "where is the bevel tool", NOVA,
     "Nova: input-only bubble, then the outline on Bevel and the trail"),
    ("2-lesson", BLENDER, CHECKLIST, [(9.0, 33.6)], "Blender", "teach me to start a donut", NOVA,
     "Nova: each step checks off, the next is pointed at at once"),
    ("3-open", LINEAR_RIGHT, None, [(1.2, 10.8)], "Finder", "open ENG-6309", ASTRA, "Astra: issue key, opens Linear with no model call"),
    ("4-explain", LINEAR, None, [(5.6, 22.0)], "Linear", "what is this ticket?", ASTRA, "Astra: explains it out loud"),
    ("5-handoff", LINEAR, None, [(1.5, 7.0)], "Linear", "TEST: hand this off", ASTRA, "Astra: TEST handoff to her thread"),
    ("6-help", LINEAR, None, [(1.0, 13.0)], "Linear", "what can you do here?", ASTRA, "Astra: what she can do in this app"),
]
# (scene, second of the raw scene) for proof/morning-still-*.png
STILLS = [("1-bevel", 10.0), ("2-lesson", 21.0), ("4-explain", 16.0), ("6-help", 8.0)]


def main():
    inputs, filters, joined = [], [], []
    placed = {}  # scene -> [(raw start, raw end, output start)]
    at, k = 0.0, 0
    for i, (name, crop, inset, cuts, app, question, who, why) in enumerate(SCENES):
        mov = os.path.join(ROOT, f"build/morning-{name}.mov")
        duration, has_audio = cut.probe(mov)
        bar = cut.header(i + 1, app, question, who, why)
        for start, end in cuts:
            end = min(end, duration)
            placed.setdefault(name, []).append((start, end, at))
            at += (end - start) / SPEED
            inputs += ["-i", mov, "-loop", "1", "-i", bar]
            v, b = 2 * k, 2 * k + 1
            # ScreenCaptureKit writes a frame only when the screen changes, so a still caption ends the video
            # track early: hold the last frame for as long as the audio runs.
            trim = f"[{v}:v]tpad=stop_mode=clone:stop_duration=60,trim={start:.2f}:{end:.2f},setpts=(PTS-STARTPTS)/{SPEED},"
            frame = trim + (f"split[m{k}][n{k}];[m{k}]" if inset else "")
            filters.append(
                frame + f"crop={crop},scale={W}:{H - BAR}:force_original_aspect_ratio=decrease,"
                f"pad={W}:{H - BAR}:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,setsar=1[p{k}]"
            )
            if inset:
                filters.append(f"[n{k}]crop={inset},scale=iw*0.95:-2,pad=iw+4:ih+4:2:2:color=0x3a3d44,fps=30,setsar=1[i{k}];"
                               f"[p{k}][i{k}]overlay=W-w-12:12[c{k}]")
            else:
                filters.append(f"[p{k}]null[c{k}]")
            filters.append(f"[{b}:v]fps=30,setsar=1[h{k}];[h{k}][c{k}]vstack=shortest=1[s{k}]")
            length = (end - start) / SPEED
            source = f"[{v}:a]aresample=48000,aformat=channel_layouts=stereo,atrim={start:.2f}:{end:.2f}," \
                if has_audio else f"anullsrc=r=48000:cl=stereo,atrim=0:{end - start:.3f},"
            filters.append(f"{source}asetpts=PTS-STARTPTS,atempo={SPEED},apad,atrim=0:{length:.3f}[a{k}]")
            joined += [f"[s{k}]", f"[a{k}]"]
            k += 1
    filters.append("".join(joined) + f"concat=n={k}:v=1:a=1[out][aout]")
    out = os.path.join(ROOT, "proof/morning-demo.mp4")
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", *inputs, "-filter_complex", ";".join(filters), "-map", "[out]", "-map", "[aout]",
         "-c:a", "aac", "-b:a", "160k", "-c:v", "libx264", "-crf", "22", "-preset", "slow", "-pix_fmt", "yuv420p",
         "-movflags", "+faststart", out],
        check=True,
    )
    print(f"{out} ({at:.1f}s)")
    for n, (name, second) in enumerate(STILLS):
        start, _, offset = next(p for p in placed[name] if p[0] <= second <= p[1])
        still = os.path.join(ROOT, f"proof/morning-still-{n + 1}-{name.split('-', 1)[1]}.png")
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{offset + (second - start) / SPEED:.2f}", "-i", out,
                        "-frames:v", "1", still], check=True)
        print(still)


if __name__ == "__main__":
    main()
