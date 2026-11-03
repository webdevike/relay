#!/usr/bin/env python3
"""Cuts build/assist-*.mov (tools/record-assistant.sh) into proof/assistant-cursor.mp4: each scene
cropped around the action, under a header naming the app, the question and who answered (with her
avatar from the cache Relay Assist draws). 1280x720, phone friendly.
--voice: keeps each scene's recorded audio (the assistants' spoken replies) and writes
proof/assistant-cursor-voice.mp4; a scene without an audio track gets silence."""
import glob
import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AVATARS = os.path.expanduser("~/Library/Caches/RelayBuddy/avatars")
W, H, BAR = 1280, 720, 64
NOVA, ASTRA = ("nova", "#f76707"), ("astra", "#1c7ed6")
# name, crop w:h:x:y on the 3840x1080 display, app, question, who answers and why
SCENES = [
    ("1-blender", "1600:900:0:0", "Blender", "where is the bevel tool", NOVA, "Nova, by default"),
    ("2-finder", "1440:810:1790:0", "Finder", "open ENG-6309", ASTRA, "Astra: issue key, shortcut opens Linear"),
    ("3-linear", "1440:810:1790:0", "Linear", "what is this ticket?", ASTRA, "Astra: Linear is in front"),
    ("4-settings", "1280:720:900:30", "System Settings", "Nova, where is Wi-Fi", NOVA, "Nova, named in the question"),
]


def font(size, bold=False):
    for path in ["/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"]:
        if os.path.exists(path):
            f = ImageFont.truetype(path, size)
            try:
                f.set_variation_by_name("Semibold" if bold else "Regular")
            except Exception:
                pass
            return f
    return ImageFont.load_default()


def header(index, app, question, who, why):
    agent, accent = who
    bar = Image.new("RGB", (W, BAR), "#15171c")
    draw = ImageDraw.Draw(bar)
    draw.rectangle([0, BAR - 4, W, BAR], fill=accent)
    face = sorted(glob.glob(f"{AVATARS}/{agent}-*.png"))
    x = 16
    if face:
        img = Image.open(face[0]).convert("RGBA").resize((46, 46), Image.LANCZOS)
        bar.paste(img, (x, 7), img)
        x += 58
    draw.text((x, 9), f"{index}  {app}:  \u201c{question}\u201d", font=font(22, True), fill="white")
    draw.text((x, 36), f"\u2192 {why}", font=font(17), fill=accent)
    path = f"/tmp/assist-bar-{index}.png"
    bar.save(path)
    return path


def probe(path):
    """(duration in seconds, has an audio stream)."""
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", path],
                         capture_output=True, text=True, check=True).stdout
    info = json.loads(out)
    return float(info["format"]["duration"]), any(s.get("codec_type") == "audio" for s in info.get("streams", []))


def main():
    voice = "--voice" in sys.argv
    inputs, filters, joined = [], [], []
    for i, (name, crop, app, question, who, why) in enumerate(SCENES):
        mov = os.path.join(ROOT, f"build/assist-{name}.mov")
        inputs += ["-i", mov, "-loop", "1", "-i", header(i + 1, app, question, who, why)]
        v, b = 2 * i, 2 * i + 1
        filters.append(
            f"[{v}:v]crop={crop},scale={W}:{H - BAR}:force_original_aspect_ratio=decrease,"
            f"pad={W}:{H - BAR}:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,setsar=1[c{i}];"
            f"[{b}:v]fps=30,setsar=1[h{i}];[h{i}][c{i}]vstack=shortest=1[s{i}]"
        )
        joined.append(f"[s{i}]")
        if voice:
            duration, has_audio = probe(mov)
            source = f"[{v}:a]aresample=48000,aformat=channel_layouts=stereo," if has_audio else \
                "anullsrc=r=48000:cl=stereo,"
            filters.append(f"{source}apad,atrim=0:{duration:.3f},asetpts=PTS-STARTPTS[a{i}]")
            joined.append(f"[a{i}]")
    filters.append("".join(joined) + f"concat=n={len(SCENES)}:v=1:a={1 if voice else 0}" + ("[out][aout]" if voice else "[out]"))
    out = os.path.join(ROOT, "proof/assistant-cursor-voice.mp4" if voice else "proof/assistant-cursor.mp4")
    audio = ["-map", "[aout]", "-c:a", "aac", "-b:a", "160k"] if voice else []
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", *inputs, "-filter_complex", ";".join(filters), "-map", "[out]", *audio,
         "-c:v", "libx264", "-crf", "22", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
        check=True,
    )
    print(out)


if __name__ == "__main__":
    main()
