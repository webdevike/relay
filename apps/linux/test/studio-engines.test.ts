// The local engines behind Studio's editor tools: the `sam` and `crop` backends' descriptors and checks, the
// ffmpeg commands for crops and masked edits (argv, then the real ffmpeg), the crop runner, and the SAM 2.1 runner
// against a stand-in python (the real model never runs in tests).

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_STUDIO_SEGMENTS, type StudioAsset, type StudioSpec } from "@relay/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { findTool } from "../src/drops/video";
import { BACKEND_BASE, baseEstimateMs, STUDIO_BACKENDS, STUDIO_POOLS, validateSpec } from "../src/studio/backends";
import { CropRunner } from "../src/studio/crop";
import { compositeMaskedArgv, cropArgv, ffmpegMedia, type StudioMedia } from "../src/studio/media";
import type { StudioRunInput } from "../src/studio/runner";
import { SAM_SCRIPT, SamRunner, segmentImage, type SamPaths } from "../src/studio/sam";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-studio-engines-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runInput(spec: StudioSpec, over: Partial<StudioRunInput> = {}): StudioRunInput & { notes: string[] } {
  const notes: string[] = [];
  return {
    spec,
    frames: {},
    refs: [],
    workDir: freshDir(),
    signal: new AbortController().signal,
    note: (text) => notes.push(text),
    blocked: () => undefined,
    notes,
    ...over,
  };
}

const samSpec = (over: Partial<StudioSpec> = {}): StudioSpec => ({
  mode: "image",
  backend: "sam",
  model: "cutout",
  prompt: "Remove background",
  aspect: "9:16",
  resolution: "source",
  refs: ["img"],
  ...over,
});

const cropSpec = (over: Partial<StudioSpec> = {}): StudioSpec => ({
  ...samSpec({ backend: "crop", model: "crop", prompt: "Crop", aspect: "16:9", params: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 } }),
  ...over,
});

describe("sam and crop backends", () => {
  const image: StudioAsset = {
    id: "img",
    kind: "image",
    mimeType: "image/png",
    width: 1024,
    height: 1536,
    size: 10,
    path: "/studio/img/t",
    thumb: "/studio/img/t/thumb",
    origin: "output",
    createdAt: 1,
  };
  const lookup = (id: string): StudioAsset | undefined => (id === "img" || id === "img2" ? { ...image, id } : undefined);
  const sam = { ...BACKEND_BASE.sam, available: true };
  const crop = { ...BACKEND_BASE.crop, available: true };

  it("lists both, SAM in the GPU queue and crops several at once", () => {
    expect(STUDIO_BACKENDS.slice(-3)).toEqual(["sam", "crop", "higgsfield"]);
    expect(BACKEND_BASE.sam).toMatchObject({ label: "SAM 2.1", mode: "image", refs: 1, seed: false, serial: true, paid: false });
    expect(BACKEND_BASE.crop).toMatchObject({ label: "Crop", mode: "image", refs: 1, seed: false, serial: false, paid: false });
    expect(BACKEND_BASE.sam.models?.map((model) => model.id)).toEqual(["cutout"]);
    expect(BACKEND_BASE.crop.models?.map((model) => model.id)).toEqual(["crop"]);
    expect(STUDIO_POOLS.sam).toEqual({ pool: "gpu", max: 1 });
    expect(STUDIO_POOLS.crop.pool).not.toBe("gpu");
    expect(STUDIO_POOLS.crop.max).toBeGreaterThan(1);
    expect(baseEstimateMs(samSpec())).toBeGreaterThan(baseEstimateMs(samSpec({ mask: "seg-1" })));
    expect(baseEstimateMs(cropSpec())).toBeLessThan(10_000);
  });

  it("takes a cutout of exactly one image, at the source size, with or without a mask", () => {
    expect(validateSpec(samSpec(), sam, lookup)).toBeNull();
    expect(validateSpec(samSpec({ mask: "seg-1", aspect: "1:1" }), sam, lookup)).toBeNull();
    expect(validateSpec(samSpec({ refs: [] }), sam, lookup)).toBe("Add a reference image to edit");
    expect(validateSpec(samSpec({ refs: ["img", "img2"] }), sam, lookup)).toBe("Remove background takes at most 1 reference images");
    expect(validateSpec(samSpec({ model: undefined }), sam, lookup)).toBe("Pick a model");
    expect(validateSpec(samSpec({ resolution: "1mp" }), sam, lookup)).toBe("Remove background has no 1mp at 9:16");
    expect(validateSpec(samSpec({ params: { x: 1 } }), sam, lookup)).toBe("Remove background has no setting x");
    expect(validateSpec(samSpec({ refs: ["gone"] }), sam, lookup)).toBe("A frame or reference image is gone; pick it again");
  });

  it("crops a rectangle inside the picture and nothing else", () => {
    expect(validateSpec(cropSpec(), crop, lookup)).toBeNull();
    expect(validateSpec(cropSpec({ params: {} }), crop, lookup)).toBeNull();
    expect(validateSpec(cropSpec({ params: { x: 0.7, w: 0.3 } }), crop, lookup)).toBeNull();
    expect(validateSpec(cropSpec({ params: { x: 0.3333334, w: 0.6666667 } }), crop, lookup)).toBeNull();
    expect(validateSpec(cropSpec({ params: { x: -0.1 } }), crop, lookup)).toBe("Left must be between 0 and 1");
    expect(validateSpec(cropSpec({ params: { h: 1.5 } }), crop, lookup)).toBe("Height must be between 0 and 1");
    expect(validateSpec(cropSpec({ params: { w: "half" } }), crop, lookup)).toBe("Width must be between 0 and 1");
    expect(validateSpec(cropSpec({ params: { w: 0.001 } }), crop, lookup)).toBe("The crop is too small");
    expect(validateSpec(cropSpec({ params: { x: 0.6, w: 0.5 } }), crop, lookup)).toBe("The crop goes past the edge of the picture");
    expect(validateSpec(cropSpec({ params: { y: 0.9, h: 0.2 } }), crop, lookup)).toBe("The crop goes past the edge of the picture");
    expect(validateSpec(cropSpec({ params: { z: 1 } }), crop, lookup)).toBe("Crop has no setting z");
    expect(validateSpec(cropSpec({ mask: "seg-1" }), crop, lookup)).toBe("Crop takes no mask");
    expect(validateSpec(cropSpec({ refs: [] }), crop, lookup)).toBe("Add a reference image to edit");
    expect(validateSpec(cropSpec({ refs: ["img", "img2"] }), crop, lookup)).toBe("Crop takes at most 1 reference images");
  });
});

describe("crop and masked edit commands", () => {
  it("crops with whole-pixel expressions of the input's size", () => {
    expect(cropArgv("/ffmpeg", "/in.png", "/out.png", [0.1, 0.25, 0.5, 0.0000001])).toEqual([
      "/ffmpeg", "-v", "error", "-y", "-i", "/in.png", "-frames:v", "1",
      "-vf", "crop=w=max(1\\,round(iw*0.500000)):h=max(1\\,round(ih*0.000000)):x=round(iw*0.100000):y=round(ih*0.250000):exact=1",
      "-update", "1", "/out.png",
    ]);
    expect(cropArgv("/ffmpeg", "/in.jpg", "/out.JPG", [0, 0, 1, 1])).toContain("-q:v");
  });

  it("lays the edit over the source through the feathered mask, scaled to the source", () => {
    const argv = compositeMaskedArgv("/ffmpeg", { source: "/src.png", edited: "/edit.png", mask: "/mask.png", out: "/out.png" }, 1024, 1536);
    expect(argv).toEqual([
      "/ffmpeg", "-v", "error", "-y",
      "-i", "/src.png", "-i", "/edit.png", "-i", "/mask.png",
      "-filter_complex",
      "[0:v]format=rgb24[source];" +
        "[1:v]scale=1024:1536:flags=lanczos,format=rgb24[edited];" +
        "[2:v]format=gray,scale=1024:1536:flags=bilinear,gblur=sigma=5[mask];" +
        "[edited][mask]alphamerge[inside];" +
        "[source][inside]overlay=format=rgb,format=rgb24[out]",
      "-map", "[out]", "-frames:v", "1", "-update", "1", "/out.png",
    ]);
    // The feather follows the short side, never under a pixel; JPEG outputs get a quality.
    expect(compositeMaskedArgv("/ffmpeg", { source: "a", edited: "b", mask: "c", out: "d.png" }, 120, 90).join(" ")).toContain("gblur=sigma=1[");
    expect(compositeMaskedArgv("/ffmpeg", { source: "a", edited: "b", mask: "c", out: "d.jpg" }, 3000, 2000).join(" ")).toContain("gblur=sigma=10[");
    expect(compositeMaskedArgv("/ffmpeg", { source: "a", edited: "b", mask: "c", out: "d.jpg" }, 3000, 2000)).toContain("-q:v");
  });
});

/** StudioMedia that records crops and writes placeholder files. */
function cropMedia(): StudioMedia & { crops: { src: string; dest: string; box: readonly number[] }[] } {
  const crops: { src: string; dest: string; box: readonly number[] }[] = [];
  const unused = (): Promise<never> => Promise.reject(new Error("not used by crops"));
  return {
    crops,
    probe: () => Promise.resolve({}),
    thumb: () => Promise.resolve(false),
    frame: unused,
    jpeg: unused,
    cover: unused,
    compositeMasked: unused,
    crop: (src, dest, box) => {
      crops.push({ src, dest, box });
      writeFileSync(dest, "x");
      return Promise.resolve();
    },
  };
}

describe("crop runner", () => {
  it("is there when ffmpeg is", async () => {
    expect(await new CropRunner(cropMedia(), () => "/ffmpeg").describe()).toMatchObject({ id: "crop", available: true, serial: false });
    const missing = await new CropRunner(cropMedia(), () => null).describe();
    expect(missing).toMatchObject({ id: "crop", available: false });
    expect(missing.reason).toContain("ffmpeg");
  });

  it("cuts the spec's rectangle and keeps JPEG as JPEG, everything else as PNG", async () => {
    const media = cropMedia();
    const runner = new CropRunner(media, () => "/ffmpeg");
    const jpeg = runInput(cropSpec(), { refs: ["/s/a.jpeg"] });
    expect(await runner.run(jpeg)).toEqual({ path: join(jpeg.workDir, "out.jpg"), mimeType: "image/jpeg" });
    const png = runInput(cropSpec({ params: { y: 0.5, h: 0.5 } }), { refs: ["/s/b.webp"] });
    expect(await runner.run(png)).toEqual({ path: join(png.workDir, "out.png"), mimeType: "image/png" });
    expect(media.crops).toEqual([
      { src: "/s/a.jpeg", dest: join(jpeg.workDir, "out.jpg"), box: [0.1, 0.2, 0.5, 0.4] },
      { src: "/s/b.webp", dest: join(png.workDir, "out.png"), box: [0, 0.5, 1, 0.5] },
    ]);
    expect(jpeg.notes).toEqual(["Cropping"]);
    await expect(runner.run(runInput(cropSpec()))).rejects.toThrow("Crop needs an image");
  });
});

describe("SAM 2.1 runner", () => {
  /** A SAM install in a temp dir: a cached snapshot and a stand-in python (`sh`) whose body is `script`. */
  const install = (script: string): { dir: string; paths: SamPaths } => {
    const dir = freshDir();
    const paths = { python: join(dir, "python"), snapshots: join(dir, "snapshots") };
    mkdirSync(join(paths.snapshots, "abc"), { recursive: true });
    writeFileSync(
      paths.python,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\necho "$HF_HUB_OFFLINE $TRANSFORMERS_OFFLINE" > "${dir}/offline"\ncp "$1" "${dir}/script.py"\n${script}\n`,
    );
    chmodSync(paths.python, 0o755);
    return { dir, paths };
  };
  /** What the real script prints and writes for `segments IMAGE OUTDIR MAX`. */
  const segmentsScript = (json: string): string =>
    `printf '[sam] Loading SAM 2.1\\n[sam] Finding objects (1 of 4)\\nW1106 a torch warning\\n' >&2\necho m > "$4/segment-1-mask.png"\necho c > "$4/segment-1-cutout.png"\nprintf '%s' '${json}' > "$4/segments.json"`;
  const listed = JSON.stringify({
    segments: [
      { label: "Background", box: [0, 0, 1, 1], area: 0.7, mask: "segment-1-mask.png", cutout: "segment-1-cutout.png" },
      { label: "Subject", box: [0.27, 0.06, 0.48, 0.91], area: 0.28, mask: "segment-2-mask.png", cutout: "segment-2-cutout.png" },
    ],
  });

  it("is there only with its python and the model in the Hugging Face cache", async () => {
    const { dir, paths } = install("");
    expect(await new SamRunner(paths).describe()).toMatchObject({ id: "sam", available: true, serial: true, seed: false, refs: 1 });
    const noPython = await new SamRunner({ ...paths, python: join(dir, "nope") }).describe();
    expect(noPython).toMatchObject({ available: false });
    expect(noPython.reason).toContain("RELAY_STUDIO_SAM_PYTHON");
    const uncached = await new SamRunner({ ...paths, snapshots: join(dir, "none") }).describe();
    expect(uncached.reason).toContain("facebook/sam2.1-hiera-large is not in the Hugging Face cache");
  });

  it("runs the script offline, shows its status lines and returns the objects with absolute paths", async () => {
    const { dir, paths } = install(segmentsScript(listed));
    const outDir = freshDir();
    const notes: string[] = [];
    const found = await segmentImage({ python: paths.python, image: "/lib/a.png", outDir, note: (text) => notes.push(text) });
    const argv = readFileSync(join(dir, "argv"), "utf8").trim().split("\n");
    expect(argv.slice(1)).toEqual(["segments", "/lib/a.png", outDir, String(MAX_STUDIO_SEGMENTS)]);
    expect(readFileSync(join(dir, "script.py"), "utf8")).toBe(SAM_SCRIPT);
    expect(existsSync(argv[0] ?? "")).toBe(false); // the scratch copy of the script is gone
    expect(readFileSync(join(dir, "offline"), "utf8").trim()).toBe("1 1");
    expect(notes).toEqual(["Loading SAM 2.1", "Finding objects (1 of 4)"]);
    expect(found).toEqual([
      { label: "Background", box: [0, 0, 1, 1], area: 0.7, mask: join(outDir, "segment-1-mask.png"), cutout: join(outDir, "segment-1-cutout.png") },
      { label: "Subject", box: [0.27, 0.06, 0.48, 0.91], area: 0.28, mask: join(outDir, "segment-2-mask.png"), cutout: join(outDir, "segment-2-cutout.png") },
    ]);
    expect(await new SamRunner(paths).segment("/lib/a.png", outDir, new AbortController().signal)).toEqual(found);
  });

  it("fails in one line: the script's own error, or an unreadable list", async () => {
    const failing = install(`printf '[sam] Loading SAM 2.1\\nTraceback\\n[sam] error: cannot identify image file /lib/a.png\\n' >&2\nexit 1`);
    await expect(segmentImage({ python: failing.paths.python, image: "/lib/a.png", outDir: freshDir() })).rejects.toThrow(
      /^cannot identify image file \/lib\/a\.png$/,
    );
    const crashing = install(`echo 'Segmentation fault' >&2\nexit 139`);
    await expect(segmentImage({ python: crashing.paths.python, image: "/lib/a.png", outDir: freshDir() })).rejects.toThrow("Segmentation fault");
    const silent = install("exit 0");
    await expect(segmentImage({ python: silent.paths.python, image: "/lib/a.png", outDir: freshDir() })).rejects.toThrow(
      "SAM 2.1 finished without a readable list of objects",
    );
    const escaping = install(segmentsScript(JSON.stringify({ segments: [{ label: "X", box: [0, 0, 1, 1], area: 1, mask: "../../etc/passwd", cutout: "c.png" }] })));
    await expect(segmentImage({ python: escaping.paths.python, image: "/lib/a.png", outDir: freshDir() })).rejects.toThrow("readable list");
  });

  it("cuts out the subject, or the picked segment's mask, to out.png", async () => {
    const { dir, paths } = install(`printf '[sam] Cutting out\\n' >&2\necho png > "$4"`);
    const runner = new SamRunner(paths);
    const auto = runInput(samSpec(), { refs: ["/lib/a.png"] });
    expect(await runner.run(auto)).toEqual({ path: join(auto.workDir, "out.png"), mimeType: "image/png" });
    expect(readFileSync(join(dir, "argv"), "utf8").trim().split("\n").slice(1)).toEqual(["cutout", "/lib/a.png", join(auto.workDir, "out.png")]);
    const masked = runInput(samSpec({ mask: "seg-2" }), { refs: ["/lib/a.png"], mask: "/studio/seg-2.png" });
    await runner.run(masked);
    expect(readFileSync(join(dir, "argv"), "utf8").trim().split("\n").slice(1)).toEqual(["cutout", "/lib/a.png", join(masked.workDir, "out.png"), "/studio/seg-2.png"]);
    expect(masked.notes).toEqual(["Cutting out"]);
    await expect(runner.run(runInput(samSpec()))).rejects.toThrow("SAM 2.1 needs an image");
    const empty = new SamRunner(install("exit 0").paths);
    await expect(empty.run(runInput(samSpec(), { refs: ["/lib/a.png"] }))).rejects.toThrow("SAM 2.1 finished without writing the cutout");
  });

  it("stops the script on cancel", async () => {
    // The stand-in says it started, then hangs; the cancel comes on that line, not after a guessed delay.
    const { paths } = install(`printf '[sam] Loading SAM 2.1\\n' >&2\nsleep 30`);
    const controller = new AbortController();
    const running = segmentImage({
      python: paths.python,
      image: "/lib/a.png",
      outDir: freshDir(),
      signal: controller.signal,
      graceMs: 100,
      note: () => {
        controller.abort();
      },
    });
    await expect(running).rejects.toThrow("Cancelled");
  });
});

const python3 = findTool("python3");

describe.skipIf(python3 === null)("SAM 2.1 script", () => {
  it("is valid python", () => {
    const parsed = spawnSync(python3 ?? "python3", ["-c", "import ast, sys; ast.parse(sys.stdin.read())"], { input: SAM_SCRIPT });
    expect(parsed.stderr.toString()).toBe("");
    expect(parsed.status).toBe(0);
  });
});

const ffmpeg = findTool("ffmpeg");

describe.skipIf(ffmpeg === null || findTool("ffprobe") === null)("crops and masked edits on the real ffmpeg", () => {
  /** One pixel of an image as `rrggbb`. */
  const pixel = (path: string, x: number, y: number): string =>
    spawnSync(ffmpeg ?? "ffmpeg", ["-v", "error", "-i", path, "-vf", `crop=1:1:${String(x)}:${String(y)}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout.toString("hex");
  const make = (lavfi: string, out: string, ...extra: string[]): void => {
    expect(spawnSync(ffmpeg ?? "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", lavfi, "-frames:v", "1", ...extra, out]).status).toBe(0);
  };

  it("crops to the fractions and puts the edit back only inside the mask", async () => {
    const dir = freshDir();
    const media = ffmpegMedia(() => undefined);
    const source = join(dir, "source.png");
    make("testsrc2=size=640x360", source);

    const cropped = join(dir, "crop.png");
    await media.crop(source, cropped, [0.6, 0.1, 0.5, 0.25]);
    expect(await media.probe(cropped)).toMatchObject({ width: 320, height: 90 });
    const croppedJpeg = join(dir, "crop.jpg");
    await media.crop(source, croppedJpeg, [0, 0, 0.333, 1]);
    expect(await media.probe(croppedJpeg)).toMatchObject({ width: 213, height: 360 });

    // A half-size solid red edit and a white box mask; the output keeps the source's size.
    const edited = join(dir, "edited.png");
    make("color=red:size=320x180", edited);
    const mask = join(dir, "mask.png");
    make("color=black:size=640x360,drawbox=x=100:y=100:w=200:h=150:color=white:t=fill", mask, "-pix_fmt", "gray");
    const out = join(dir, "out.png");
    await media.compositeMasked(source, edited, mask, out);
    expect(await media.probe(out)).toMatchObject({ width: 640, height: 360 });
    expect(pixel(out, 200, 175)).toBe(pixel(edited, 100, 87));
    for (const [x, y] of [[20, 20], [620, 340], [400, 175]] as const) expect(pixel(out, x, y)).toBe(pixel(source, x, y));
    // The mask's edge is feathered: neither the source nor the edit (the bottom edge, where the source is green).
    const edge = pixel(out, 200, 250);
    expect(edge).not.toBe(pixel(source, 200, 250));
    expect(edge).not.toBe(pixel(edited, 100, 87));
  }, 30_000);
});
