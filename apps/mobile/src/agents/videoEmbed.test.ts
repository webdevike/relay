import type { Drop } from "@relay/protocol";
import { describe, expect, it } from "vitest";
import { audioEmbedOf, modelEmbedOf, videoEmbedOf } from "./videoEmbed";

const TOKEN = "ab".repeat(32);
const path = (id: string) => `/drops/${id}/${TOKEN}`;

function fileDrop(id: string, mimeType: string, extra: Partial<NonNullable<Drop["file"]>> = {}): Drop {
  return {
    id,
    kind: mimeType.startsWith("image/") ? "image" : "file",
    origin: "host",
    createdAt: 1,
    title: id,
    file: { name: id, mimeType, size: 10, path: path(id), ...extra },
  };
}

const drops: Drop[] = [
  fileDrop("vid", "video/mp4", { width: 1280, height: 720, durationMs: 10_000, poster: `${path("vid")}/poster` }),
  fileDrop("bare", "video/webm"),
  fileDrop("shot", "image/png"),
  fileDrop("song", "audio/mp4", { durationMs: 17_100 }),
  fileDrop("zip", "application/zip"),
  fileDrop("glb", "model/gltf-binary"),
  fileDrop("scan", "model/gltf-binary", { poster: `${path("scan")}/poster` }),
  fileDrop("octet", "application/octet-stream", { name: "robot.glb" }),
];

describe("videoEmbedOf", () => {
  it("plays a video drop with its poster, shape and length", () => {
    expect(videoEmbedOf(path("vid"), drops)).toEqual({
      src: path("vid"),
      mimeType: "video/mp4",
      poster: `${path("vid")}/poster`,
      aspect: 1280 / 720,
      durationMs: 10_000,
    });
  });

  it("plays a video drop the host could not probe, without a poster or shape", () => {
    expect(videoEmbedOf(path("bare"), drops)).toEqual({ src: path("bare"), mimeType: "video/webm" });
  });

  it("keeps image drops, other files and drops the phone doesn't know as pictures", () => {
    expect(videoEmbedOf(path("shot"), drops)).toBeNull();
    expect(videoEmbedOf(path("zip"), drops)).toBeNull();
    expect(videoEmbedOf(path("gone"), drops)).toBeNull();
  });

  it("plays https URLs by their video extension, ignoring query and hash", () => {
    expect(videoEmbedOf("https://cdn.x.test/demo.MP4?sig=1#t=2", [])).toEqual({ src: "https://cdn.x.test/demo.MP4?sig=1#t=2" });
    expect(videoEmbedOf("https://cdn.x.test/a.mov", [])).not.toBeNull();
    expect(videoEmbedOf("https://cdn.x.test/a.png", [])).toBeNull();
    expect(videoEmbedOf("https://cdn.x.test/watch?v=demo.mp4", [])).toBeNull();
  });

  it("plays a video drop linked by its full https URL, its poster through the same origin", () => {
    const origin = "https://isaacs-mac-mini.tail80fdb0.ts.net";
    expect(videoEmbedOf(`${origin}${path("vid")}`, drops)).toEqual({
      src: `${origin}${path("vid")}`,
      mimeType: "video/mp4",
      poster: `${origin}${path("vid")}/poster`,
      aspect: 1280 / 720,
      durationMs: 10_000,
    });
    expect(videoEmbedOf(`${origin}${path("shot")}`, drops)).toBeNull();
  });

  it("never treats a path on the Mac as a playable video", () => {
    expect(videoEmbedOf("/Users/ike/Desktop/demo.mp4", drops)).toBeNull();
  });
});

describe("audioEmbedOf", () => {
  it("plays an audio drop, bare or linked by its full https URL, with its length", () => {
    expect(audioEmbedOf(path("song"), drops)).toEqual({ src: path("song"), durationMs: 17_100 });
    const url = `https://isaacs-mac-mini.tail80fdb0.ts.net${path("song")}`;
    expect(audioEmbedOf(url, drops)).toEqual({ src: url, durationMs: 17_100 });
  });

  it("plays https URLs by their audio extension and leaves everything else alone", () => {
    expect(audioEmbedOf("https://cdn.x.test/a.MP3?sig=1", [])).toEqual({ src: "https://cdn.x.test/a.MP3?sig=1" });
    expect(audioEmbedOf("https://cdn.x.test/a.png", [])).toBeNull();
    expect(audioEmbedOf(path("vid"), drops)).toBeNull();
    expect(audioEmbedOf(path("shot"), drops)).toBeNull();
    expect(audioEmbedOf(path("gone"), drops)).toBeNull();
    expect(audioEmbedOf("/Users/ike/a.mp3", drops)).toBeNull();
  });
});

describe("modelEmbedOf", () => {
  it("marks a model drop, bare or by its full https URL, with the type the host serves", () => {
    expect(modelEmbedOf(path("glb"), drops)).toEqual({ src: path("glb"), mimeType: "model/gltf-binary" });
    const url = `https://isaacs-mac-mini.tail80fdb0.ts.net${path("glb")}`;
    expect(modelEmbedOf(url, drops)).toEqual({ src: url, mimeType: "model/gltf-binary" });
  });

  it("marks a .glb drop the host serves as octet-stream", () => {
    expect(modelEmbedOf(path("octet"), drops)).toEqual({ src: path("octet"), mimeType: "application/octet-stream" });
  });

  it("carries the drop's own poster, through the same origin for a full URL", () => {
    expect(modelEmbedOf(path("scan"), drops)?.poster).toBe(`${path("scan")}/poster`);
    const origin = "https://isaacs-mac-mini.tail80fdb0.ts.net";
    expect(modelEmbedOf(`${origin}${path("scan")}`, drops)?.poster).toBe(`${origin}${path("scan")}/poster`);
  });

  it("marks https URLs by their model extension", () => {
    expect(modelEmbedOf("https://cdn.x.test/robot.GLB?sig=1", [])).toEqual({ src: "https://cdn.x.test/robot.GLB?sig=1", mimeType: "model/gltf-binary" });
    expect(modelEmbedOf("https://cdn.x.test/scene.gltf", [])).toEqual({ src: "https://cdn.x.test/scene.gltf", mimeType: "model/gltf+json" });
  });

  it("leaves pictures, video, audio, other files, unknown drops and Mac paths alone", () => {
    for (const id of ["shot", "vid", "song", "zip", "gone"]) expect(modelEmbedOf(path(id), drops)).toBeNull();
    expect(modelEmbedOf("https://cdn.x.test/a.png", [])).toBeNull();
    expect(modelEmbedOf("/Users/ike/robot.glb", drops)).toBeNull();
  });
});
