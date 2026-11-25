import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodePng } from "../src/png";

describe("encodePng", () => {
  it("writes GDI's BGRA rows as valid RGB PNG pixels", () => {
    // 2x2, top-down BGRA: red, green / blue, white (alpha 0, as GDI leaves it).
    const bgra = Uint8Array.of(0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0);
    const png = Buffer.from(encodePng(bgra, 2, 2));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const chunks = new Map<string, Buffer>();
    for (let at = 8; at < png.length; ) {
      const length = png.readUInt32BE(at);
      const type = png.toString("latin1", at + 4, at + 8);
      const data = png.subarray(at + 8, at + 8 + length);
      expect(png.readUInt32BE(at + 8 + length)).toBe(crc32(png.subarray(at + 4, at + 8 + length)));
      chunks.set(type, data);
      at += 12 + length;
    }
    const header = chunks.get("IHDR");
    expect([header?.readUInt32BE(0), header?.readUInt32BE(4), header?.[8], header?.[9]]).toEqual([2, 2, 8, 2]);
    expect(chunks.has("IEND")).toBe(true);
    const rows = inflateSync(chunks.get("IDAT") ?? Buffer.alloc(0));
    expect([...rows]).toEqual([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  });

  it("refuses a buffer that does not match the size", () => {
    expect(() => encodePng(new Uint8Array(12), 2, 2)).toThrow("expected 16 bytes");
  });
});
