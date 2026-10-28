/** A 2D affine transform as SVG's `matrix(a b c d e f)`: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Affine = readonly [number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** `m` then `n` applied inside it, like nested SVG groups `<g m><g n>`. */
export function mul(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** Nested groups, outermost first. */
export function chain(...ms: Affine[]): Affine {
  let out = IDENTITY;
  for (const m of ms) out = mul(out, m);
  return out;
}

export const translate = (x: number, y = 0): Affine => [1, 0, 0, 1, x, y];
export const scale = (x: number, y = x): Affine => [x, 0, 0, y, 0, 0];

/** `rotate(deg cx cy)`. */
export function rotate(deg: number, cx = 0, cy = 0): Affine {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return chain(translate(cx, cy), [cos, sin, -sin, cos, 0, 0], translate(-cx, -cy));
}

/** Scale by `sx sy` about `cx cy`. */
export const scaleAbout = (sx: number, sy: number, cx: number, cy: number): Affine =>
  chain(translate(cx, cy), scale(sx, sy), translate(-cx, -cy));

/** The inverse of an invertible transform. */
export function invert(m: Affine): Affine {
  const det = m[0] * m[3] - m[1] * m[2];
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

/** Apply `m` to a point. */
export const apply = (m: Affine, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

/** An SVG `transform` attribute (translate / rotate / scale / matrix lists) as one matrix. */
export function parseTransform(text: string): Affine {
  let out = IDENTITY;
  for (const [, fn, args] of text.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const n = (args ?? "")
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    const at = (i: number, d = 0): number => n[i] ?? d;
    switch (fn) {
      case "translate":
        out = mul(out, translate(at(0), at(1)));
        break;
      case "scale":
        out = mul(out, scale(at(0, 1), at(1, at(0, 1))));
        break;
      case "rotate":
        out = mul(out, rotate(at(0), at(1), at(2)));
        break;
      case "matrix":
        out = mul(out, [at(0, 1), at(1), at(2), at(3, 1), at(4), at(5)]);
        break;
      case undefined:
      default:
        throw new Error(`unsupported transform ${fn ?? ""}`);
    }
  }
  return out;
}

/** `matrix(...)` for an SVG `transform` attribute. */
export const matrixAttr = (m: Affine): string =>
  `matrix(${m.map((v) => Math.round(v * 1e4) / 1e4).join(" ")})`;
