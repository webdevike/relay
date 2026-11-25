// A screenshot as PNG: 8-bit RGB from the top-down BGRA rows GDI's GetDIBits returns. RGB rather
// than RGBA because the desktop has no meaningful alpha (GDI leaves it 0).

import { crc32, deflateSync } from "node:zlib";

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(Buffer.from(type, "latin1"), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** PNG bytes of a `width` x `height` image whose rows are top-down BGRA (4 bytes a pixel). */
export function encodePng(bgra: Uint8Array, width: number, height: number): Uint8Array {
  if (bgra.length !== width * height * 4) throw new Error(`expected ${width * height * 4} bytes, got ${bgra.length}`);
  const stride = width * 3 + 1; // filter byte (0, none) then RGB
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    let o = y * stride + 1;
    let i = y * width * 4;
    for (let x = 0; x < width; x++, i += 4, o += 3) {
      raw[o] = bgra[i + 2] ?? 0;
      raw[o + 1] = bgra[i + 1] ?? 0;
      raw[o + 2] = bgra[i] ?? 0;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8); // bit depth 8, colour type 2 (RGB), deflate, no filter set, no interlace
  const parts = [SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 4 })), chunk("IEND", new Uint8Array())];
  return Buffer.concat(parts);
}
