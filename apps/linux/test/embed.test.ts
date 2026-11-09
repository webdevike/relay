import { describe, expect, it } from "vitest";
import { embedFor, IPHONE_VIDEO_FIX } from "../src/drops/embed";
import { modelMimeOf } from "../src/drops/model";

const path = "/drops/abc/tok";

describe("embedFor", () => {
  it.each([
    ["shot.png", "image/png"],
    ["photo.jpg", "image/jpeg"],
    ["loop.gif", "image/gif"],
  ])("embeds image %s as markdown", (name, mimeType) => {
    const caption = name.replace(/\.[^.]+$/, "");
    expect(embedFor({ name, mimeType, path })).toEqual({ kind: "image", lines: [`embed ![${caption}](${path})`], warnings: [] });
  });

  it("embeds H.264 mp4 and mov as markdown with no warning", () => {
    expect(embedFor({ name: "demo.mp4", mimeType: "video/mp4", path, codec: "h264" })).toEqual({ kind: "video", lines: [`embed ![demo](${path})`], warnings: [] });
    expect(embedFor({ name: "clip.mov", mimeType: "video/quicktime", path, codec: "h264" })).toEqual({ kind: "video", lines: [`embed ![clip](${path})`], warnings: [] });
    // Codec unknown (no ffprobe): no guess.
    expect(embedFor({ name: "demo.mp4", mimeType: "video/mp4", path }).warnings).toEqual([]);
  });

  it("warns with the ffmpeg fix for webm and non-H.264 video", () => {
    const webm = embedFor({ name: "rec.webm", mimeType: "video/webm", path });
    expect(webm.lines).toEqual([`embed ![rec](${path})`]);
    expect(webm.warnings).toEqual([`warning: iPhone can't play webm video; re-encode to mp4 H.264 and share that: ${IPHONE_VIDEO_FIX}`]);
    expect(IPHONE_VIDEO_FIX).toBe("ffmpeg -i in -c:v libx264 -pix_fmt yuv420p -movflags +faststart -c:a aac out.mp4");
    const hevc = embedFor({ name: "phone.mov", mimeType: "video/quicktime", path, codec: "hevc" });
    expect(hevc.warnings[0]).toMatch(/^warning: iPhone can't play hevc video; .*libx264/);
  });

  it("embeds audio as markdown, warning only for formats the iPhone can't play", () => {
    expect(embedFor({ name: "take.m4a", mimeType: "audio/mp4", path })).toEqual({ kind: "audio", lines: [`embed ![take](${path})`], warnings: [] });
    expect(embedFor({ name: "song.mp3", mimeType: "audio/mpeg", path })).toEqual({ kind: "audio", lines: [`embed ![song](${path})`], warnings: [] });
    expect(embedFor({ name: "voice.ogg", mimeType: "audio/ogg", path }).warnings[0]).toMatch(/^warning: iPhone cannot play/);
  });

  it("prints an openui Model block for GLB and GLTF, never markdown", () => {
    const block = (caption: string): string[] => [
      "embed (3D models only render in an openui Model block; never as markdown ![..]):",
      "```openui",
      `root = Model("${path}", ${JSON.stringify(caption)})`,
      "```",
    ];
    expect(embedFor({ name: "mug.glb", mimeType: "model/gltf-binary", path })).toEqual({ kind: "model", lines: block("mug"), warnings: [] });
    expect(embedFor({ name: "scene.gltf", mimeType: "application/octet-stream", path })).toEqual({ kind: "model", lines: block("scene"), warnings: [] });
    expect(embedFor({ name: "noext", mimeType: "model/gltf+json", path }).kind).toBe("model");
    // The caption is a JS string: quotes and backslashes are escaped.
    expect(embedFor({ name: 'say "hi" \\ there.glb', mimeType: "model/gltf-binary", path }).lines[2]).toBe(`root = Model("${path}", "say \\"hi\\" \\\\ there")`);
  });

  it("links other 3D formats with a convert-to-GLB warning", () => {
    for (const [name, mimeType] of [
      ["part.stl", "model/stl"],
      ["mesh.obj", "application/octet-stream"],
      ["rig.fbx", "application/octet-stream"],
      ["ar.usdz", "model/vnd.usdz+zip"],
    ] as const) {
      const embed = embedFor({ name, mimeType, path });
      expect(embed.kind).toBe("file");
      expect(embed.lines).toEqual([`link [${name}](${path})`]);
      expect(embed.warnings).toEqual([
        "warning: Relay only renders 3D as GLB in an openui Model block; convert first (e.g. bun -e or python trimesh: trimesh.load('in.stl').export('out.glb')) and share the .glb",
      ]);
    }
  });

  it("links a PDF or any other file, never as a markdown image", () => {
    const pdf = embedFor({ name: "report.pdf", mimeType: "application/pdf", path });
    expect(pdf).toEqual({ kind: "file", lines: [`link [report.pdf](${path})`], warnings: ["note: application/pdf has no inline embed in Relay; it shows as a link"] });
    expect(pdf.lines.join("\n")).not.toContain("![");
  });
});

describe("modelMimeOf", () => {
  it("names GLB/GLTF by extension only when the client sent nothing specific", () => {
    expect(modelMimeOf("mug.glb", "")).toBe("model/gltf-binary");
    expect(modelMimeOf("mug.GLB", "application/octet-stream")).toBe("model/gltf-binary");
    expect(modelMimeOf("scene.gltf", "application/octet-stream")).toBe("model/gltf+json");
    expect(modelMimeOf("mug.glb", "model/gltf-binary")).toBe("model/gltf-binary");
    expect(modelMimeOf("a.bin", "application/octet-stream")).toBe("application/octet-stream");
  });
});
