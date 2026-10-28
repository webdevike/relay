import { describe, expect, it } from "vitest";
import { canvasEmbedUrl, parseEmbedEvent, staysInRoom } from "./embed";

const ROOM = "http://100.85.157.127:7817/canvas/artifacts/?token=t1";

describe("canvas embed", () => {
  it("adds the phone embed mode and theme after the token", () => {
    expect(canvasEmbedUrl(ROOM, "dark")).toBe(`${ROOM}&embed=phone&theme=dark`);
    expect(canvasEmbedUrl("http://h:1/canvas/a/", "light")).toBe("http://h:1/canvas/a/?embed=phone&theme=light");
  });

  it("parses the page's events and rejects anything else", () => {
    expect(parseEmbedEvent('{"type":"canvas.ready","slug":"artifacts"}')).toEqual({ type: "canvas.ready", slug: "artifacts" });
    expect(parseEmbedEvent('{"type":"canvas.ended","slug":"artifacts","summary":"Picked B."}')).toEqual({
      type: "canvas.ended",
      slug: "artifacts",
      summary: "Picked B.",
    });
    expect(parseEmbedEvent('{"type":"canvas.ended","slug":"artifacts"}')).toEqual({ type: "canvas.ended", slug: "artifacts", summary: null });
    expect(parseEmbedEvent('{"type":"canvas.ready"}')).toBeNull();
    expect(parseEmbedEvent('{"type":"other","slug":"a"}')).toBeNull();
    expect(parseEmbedEvent("null")).toBeNull();
    expect(parseEmbedEvent("not json")).toBeNull();
  });

  it("keeps the host's own pages in the room and sends other links out", () => {
    expect(staysInRoom("http://100.85.157.127:7817/canvas/artifacts/img?token=t1&src=a.png", ROOM)).toBe(true);
    expect(staysInRoom("HTTP://100.85.157.127:7817/", ROOM)).toBe(true);
    expect(staysInRoom("about:blank", ROOM)).toBe(true);
    expect(staysInRoom("https://github.com/isaac/relay/pull/1", ROOM)).toBe(false);
    expect(staysInRoom("http://100.85.157.127:7818/", ROOM)).toBe(false);
    expect(staysInRoom("mailto:isaac@example.com", ROOM)).toBe(false);
  });
});
