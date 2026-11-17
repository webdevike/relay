#!/usr/bin/env python3
"""Builds the replay fixture for the capture helper's screen-share snapshots.

fixture/share.mp4: 40 s of a fake screen share at 1280x720, three slides (0-14 s, 14-27 s,
27-40 s) with a small box drifting across them (a cursor-sized change that must not count as a new
slide). fixture/share.json: sharing is on from 2 s to 38 s of the replay clock. fixture/app.wav and
fixture/mic.wav: 1 s of 16 kHz mono silence (the helper's replay keeps going with silence after the
end of a file).

  python3 proof/meeting-share/make-fixture.py
  RelayMeetingCapture serve --spool /tmp/spool --replay proof/meeting-share/fixture --no-detect

Needs Pillow and ffmpeg (no drawtext filter needed: the slides are drawn here).
"""

import json
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
OUT = HERE / "fixture"
W, H = 1280, 720
SLIDES = [
    (14, ["Quarterly revenue", "Sales grew 12 percent in every region", "Hiring plan for next year", "Budget review on Friday"]),
    (13, ["Product roadmap", "Launch the mobile app in March", "Retire the old billing system", "Owner: Ted Plaisted"]),
    (13, ["Open questions", "Who signs the vendor contract?", "Do we keep the Austin office?", "Next sync: November 24"]),
]


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    for path in ["/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc"]:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def draw_slide(lines: list[str], path: Path) -> None:
    img = Image.new("RGB", (W, H), (245, 245, 240))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 12], fill=(40, 90, 160))
    d.text((80, 70), lines[0], font=font(64, bold=True), fill=(20, 20, 20))
    for i, line in enumerate(lines[1:]):
        d.ellipse([84, 220 + i * 90, 100, 236 + i * 90], fill=(40, 90, 160))
        d.text((120, 205 + i * 90), line, font=font(40), fill=(30, 30, 30))
    img.save(path)


def run(*args: str) -> None:
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        concat = Path(tmp) / "slides.txt"
        entries = []
        for i, (seconds, lines) in enumerate(SLIDES):
            png = Path(tmp) / f"slide{i}.png"
            draw_slide(lines, png)
            entries.append(f"file '{png}'\nduration {seconds}\n")
        # The concat demuxer needs the last file again to honour its duration.
        entries.append(f"file '{Path(tmp) / f'slide{len(SLIDES) - 1}.png'}'\n")
        concat.write_text("".join(entries))
        run(
            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
            "-f", "lavfi", "-i", "color=c=0xd03030:s=24x24:r=5",
            "-filter_complex", "[0:v]fps=5,format=yuv420p[bg];[bg][1:v]overlay=x='200+20*t':y='620-4*t':shortest=1,format=yuv420p",
            "-t", "40", "-r", "5", "-c:v", "libx264", "-crf", "26", "-preset", "veryslow", "-movflags", "+faststart",
            str(OUT / "share.mp4"),
        )
    for name in ["app", "mic"]:
        run("ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "1", "-c:a", "pcm_s16le", str(OUT / f"{name}.wav"))
    (OUT / "share.json").write_text(json.dumps({"from": 2, "to": 38}) + "\n")
    for f in sorted(OUT.iterdir()):
        print(f"{f.relative_to(HERE)}  {f.stat().st_size} bytes")


if __name__ == "__main__":
    main()
