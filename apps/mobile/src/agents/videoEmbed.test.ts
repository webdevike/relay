import type { Drop } from "@relay/protocol";
import { describe, expect, it } from "vitest";
import { videoEmbedOf } from "./videoEmbed";

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
  fileDrop("zip", "application/zip"),
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
