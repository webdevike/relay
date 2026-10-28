/**
 * A DOM-free bounding box of SVG markup: path points and curve control points, circles, ellipses
 * and rects, ignoring element transforms. Close enough for the pivots the engine scales eyes and
 * flips mouths about (the playground used the DOM's getBBox).
 */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const EMPTY: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };

const grow = (b: Box, x: number, y: number): void => {
  if (x < b.x0) b.x0 = x;
  if (x > b.x1) b.x1 = x;
  if (y < b.y0) b.y0 = y;
  if (y > b.y1) b.y1 = y;
};

/** Numbers of a path's argument list, with SVG's compact forms ("1.5.5", "-3-4", arc flags "01"). */
function numbers(text: string, arcs: boolean): number[] {
  const out: number[] = [];
  const num = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i;
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === " " || ch === "," || ch === "\n" || ch === "\t") {
      i++;
      continue;
    }
    // An arc's large-arc and sweep flags are single digits, often written without separators.
    const slot = out.length % 7;
    if (arcs && (slot === 3 || slot === 4)) {
      out.push(ch === "1" ? 1 : 0);
      i++;
      continue;
    }
    const m = num.exec(text.slice(i));
    if (m === null) break;
    out.push(Number(m[0]));
    i += m[0].length;
  }
  return out;
}

function pathBox(d: string, b: Box): void {
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  for (const [, cmd = "", args = ""] of d.matchAll(
    /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g,
  )) {
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const n = numbers(args, C === "A");
    const step = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7, Z: 0 }[C] ?? 0;
    if (step === 0) {
      x = sx;
      y = sy;
      continue;
    }
    for (let i = 0; i + step <= n.length; i += step) {
      const ox = rel ? x : 0;
      const oy = rel ? y : 0;
      const v = (k: number): number => n[i + k] ?? 0;
      if (C === "H") x = ox + v(0);
      else if (C === "V") y = oy + v(0);
      else if (C === "A") {
        x = ox + v(5);
        y = oy + v(6);
      } else {
        for (let k = 0; k < step - 2; k += 2) grow(b, ox + v(k), oy + v(k + 1));
        x = ox + v(step - 2);
        y = oy + v(step - 1);
      }
      grow(b, x, y);
      if (C === "M" && i === 0) {
        sx = x;
        sy = y;
      }
    }
  }
}

const attr = (tag: string, name: string): number =>
  Number(new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? 0);

/** The box of `markup`; `null` when it draws nothing measurable. */
export function bbox(markup: string): Box | null {
  const b = { ...EMPTY };
  for (const [tag] of markup.matchAll(/<(path|circle|ellipse|rect)\b[^>]*>/g)) {
    if (tag.startsWith("<path")) pathBox(/\sd="([^"]*)"/.exec(tag)?.[1] ?? "", b);
    else if (tag.startsWith("<rect")) {
      const x = attr(tag, "x");
      const y = attr(tag, "y");
      grow(b, x, y);
      grow(b, x + attr(tag, "width"), y + attr(tag, "height"));
    } else {
      const cx = attr(tag, "cx");
      const cy = attr(tag, "cy");
      const rx = tag.startsWith("<circle") ? attr(tag, "r") : attr(tag, "rx");
      const ry = tag.startsWith("<circle") ? rx : attr(tag, "ry");
      grow(b, cx - rx, cy - ry);
      grow(b, cx + rx, cy + ry);
    }
  }
  return b.x0 <= b.x1 ? b : null;
}

/** The centre of `markup`'s box, or `fallback` when it has none. */
export function centre(markup: string, fallback: [number, number] = [0, 0]): [number, number] {
  const b = bbox(markup);
  return b === null ? fallback : [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
}
