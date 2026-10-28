/**
 * Extended mode's geometry (ported from ~/Eva/work/avatar-animation/playground/extend.js), DOM-free:
 * mouths as resampled point rings that morph into each other, one box per eye for the eyelids, and
 * each brow's centre to rotate it about. Everything derives from the DiceBear parts a rig chose,
 * measured once per rig and part.
 */
import { bbox, type Box } from "./bbox";

/** Points per resampled ring. */
const N = 48;

// ---------- paths ----------
const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

function tokens(d: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
  let cmd = "";
  let argi = 0;
  for (let i = 0; i < d.length;) {
    const ch = d.charAt(i);
    if (ch === " " || ch === "," || ch === "\n" || ch === "\t" || ch === "\r") {
      i++;
      continue;
    }
    // Arc flags (the 4th and 5th arguments) are single digits that may be packed together.
    if (
      cmd.toUpperCase() === "A" &&
      (argi % 7 === 3 || argi % 7 === 4) &&
      (ch === "0" || ch === "1")
    ) {
      out.push(Number(ch));
      argi++;
      i++;
      continue;
    }
    re.lastIndex = i;
    const m = re.exec(d);
    if (m === null) break;
    if (/[a-z]/i.test(m[0])) {
      cmd = m[0];
      argi = 0;
      out.push(m[0]);
    } else {
      out.push(Number(m[0]));
      argi++;
    }
    i += m[0].length;
  }
  return out;
}

/** A path's subpaths as polylines (curves and arcs flattened), each with whether it closes. */
export function polylines(d: string): { pts: number[]; closed: boolean }[] {
  const t = tokens(d);
  const subs: { pts: number[]; closed: boolean }[] = [];
  let cur: { pts: number[]; closed: boolean } | null = null;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  // The last control point, for S / T reflection.
  let cx = 0;
  let cy = 0;
  let prev = "";
  let cmd = "";
  let i = 0;
  const begin = (nx: number, ny: number): { pts: number[]; closed: boolean } => {
    const s = { pts: [nx, ny], closed: false };
    subs.push(s);
    x = sx = nx;
    y = sy = ny;
    return s;
  };
  const cubic = (
    s: { pts: number[] },
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
  ): void => {
    const steps = 12;
    for (let k = 1; k <= steps; k++) {
      const u = k / steps;
      const v = 1 - u;
      s.pts.push(
        v * v * v * x + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x3,
        v * v * v * y + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y3,
      );
    }
  };
  while (i < t.length) {
    const tok = t[i];
    if (typeof tok === "string") {
      cmd = tok;
      i++;
    }
    const C = cmd.toUpperCase();
    const rel = cmd !== C;
    const n = ARGS[C] ?? 0;
    if (C === "Z") {
      if (cur !== null) cur.closed = true;
      x = sx;
      y = sy;
      cur = null;
      prev = "Z";
      continue;
    }
    const a = t.slice(i, i + n).map(Number);
    i += n;
    if (a.length < n || a.some(Number.isNaN)) break;
    const v = (k: number): number => a[k] ?? 0;
    const ax = (k: number): number => (rel ? x : 0) + v(k);
    const ay = (k: number): number => (rel ? y : 0) + v(k);
    if (C === "M") {
      cur = begin(ax(0), ay(1));
      cmd = rel ? "l" : "L"; // further pairs are implicit linetos
      prev = "M";
      continue;
    }
    cur ??= begin(x, y);
    let nx = x;
    let ny = y;
    switch (C) {
      case "L":
        nx = ax(0);
        ny = ay(1);
        cur.pts.push(nx, ny);
        break;
      case "H":
        nx = ax(0);
        cur.pts.push(nx, ny);
        break;
      case "V":
        ny = (rel ? y : 0) + v(0);
        cur.pts.push(nx, ny);
        break;
      case "C":
        cubic(cur, ax(0), ay(1), ax(2), ay(3), ax(4), ay(5));
        cx = ax(2);
        cy = ay(3);
        nx = ax(4);
        ny = ay(5);
        break;
      case "S": {
        const r = prev === "C" || prev === "S";
        const x1 = r ? 2 * x - cx : x;
        const y1 = r ? 2 * y - cy : y;
        cubic(cur, x1, y1, ax(0), ay(1), ax(2), ay(3));
        cx = ax(0);
        cy = ay(1);
        nx = ax(2);
        ny = ay(3);
        break;
      }
      case "Q":
      case "T": {
        const r = prev === "Q" || prev === "T";
        const qx = C === "Q" ? ax(0) : r ? 2 * x - cx : x;
        const qy = C === "Q" ? ay(1) : r ? 2 * y - cy : y;
        nx = C === "Q" ? ax(2) : ax(0);
        ny = C === "Q" ? ay(3) : ay(1);
        cubic(
          cur,
          x + (2 / 3) * (qx - x),
          y + (2 / 3) * (qy - y),
          nx + (2 / 3) * (qx - nx),
          ny + (2 / 3) * (qy - ny),
          nx,
          ny,
        );
        cx = qx;
        cy = qy;
        break;
      }
      case "A":
        nx = ax(5);
        ny = ay(6);
        arc(cur.pts, x, y, v(0), v(1), v(2), v(3) !== 0, v(4) !== 0, nx, ny);
        break;
    }
    x = nx;
    y = ny;
    prev = C;
  }
  return subs.filter((s) => s.pts.length >= 4);
}

/** Flatten an SVG arc (endpoint parameterisation) onto `out`. */
function arc(
  out: number[],
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  deg: number,
  large: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): void {
  if (rx === 0 || ry === 0) {
    out.push(x2, y2);
    return;
  }
  const phi = (deg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy;
  const yp = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lam = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (k * rx * yp) / ry;
  const cyp = (-k * ry * xp) / rx;
  const ccx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const ccy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number): number =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const steps = Math.max(4, Math.ceil(Math.abs(dt) / (Math.PI / 12)));
  for (let s = 1; s <= steps; s++) {
    const th = t1 + (dt * s) / steps;
    out.push(
      ccx + rx * Math.cos(th) * cos - ry * Math.sin(th) * sin,
      ccy + rx * Math.cos(th) * sin + ry * Math.sin(th) * cos,
    );
  }
}

/** `pts` resampled to `n` points evenly spaced along its length (around it, when closed). */
function resample(pts: number[], closed: boolean, n = N): { pts: Float64Array; len: number } {
  const p = closed ? [...pts, pts[0] ?? 0, pts[1] ?? 0] : pts;
  const m = p.length / 2;
  const cum = [0];
  for (let i = 1; i < m; i++)
    cum.push(
      (cum[i - 1] ?? 0) +
        Math.hypot(
          (p[2 * i] ?? 0) - (p[2 * i - 2] ?? 0),
          (p[2 * i + 1] ?? 0) - (p[2 * i - 1] ?? 0),
        ),
    );
  const len = cum[m - 1] ?? 0;
  const out = new Float64Array(2 * n);
  let seg = 1;
  for (let k = 0; k < n; k++) {
    const at = closed ? (k / n) * len : (k / (n - 1)) * len;
    while (seg < m - 1 && (cum[seg] ?? 0) < at) seg++;
    const a = cum[seg - 1] ?? 0;
    const b = cum[seg] ?? 0;
    const w = b > a ? (at - a) / (b - a) : 0;
    out[2 * k] = (p[2 * seg - 2] ?? 0) + ((p[2 * seg] ?? 0) - (p[2 * seg - 2] ?? 0)) * w;
    out[2 * k + 1] = (p[2 * seg - 1] ?? 0) + ((p[2 * seg + 1] ?? 0) - (p[2 * seg - 1] ?? 0)) * w;
  }
  return { pts: out, len };
}

function area(pts: Float64Array): number {
  const n = pts.length / 2;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += (pts[2 * i] ?? 0) * (pts[2 * j + 1] ?? 0) - (pts[2 * j] ?? 0) * (pts[2 * i + 1] ?? 0);
  }
  return Math.abs(s / 2);
}

// ---------- mouth shapes ----------

/** How a morphing ring is painted: a fill colour, or a stroke colour and width. */
export interface Paint {
  fill: string | null;
  stroke: string | null;
  width: number;
}

interface Ring extends Paint {
  /** Rings with one key (same paint) may morph into each other. */
  key: string;
  closed: boolean;
  pts: Float64Array;
  size: number;
}

/** A mouth as resampled rings. */
export type Shape = Ring[];

const attrOf = (tag: string, name: string): string | null =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** The rings of a mouth part's `<path>`s (other elements do not morph and are left out). */
export function shapeOf(markup: string): Shape {
  const rings: Ring[] = [];
  for (const [tag] of markup.matchAll(/<path\b[^>]*>/g)) {
    const stroke = attrOf(tag, "stroke");
    const fill = attrOf(tag, "fill");
    const isStroke = stroke !== null && stroke !== "none" && (fill === null || fill === "none");
    const paint: Paint = isStroke
      ? { fill: null, stroke, width: Number(attrOf(tag, "stroke-width") ?? 1) }
      : { fill: (fill ?? "#000").toLowerCase(), stroke: null, width: 0 };
    const key = isStroke ? `s|${stroke}|${paint.width}` : `f|${paint.fill ?? ""}`;
    for (const sub of polylines(attrOf(tag, "d") ?? "")) {
      const closed = !isStroke || sub.closed;
      const { pts, len } = resample(sub.pts, closed);
      rings.push({ ...paint, key, closed, pts, size: closed ? area(pts) : len });
    }
  }
  return rings;
}

/** One ring morphing from `a` to `b`; `fade` -1 fades out, 1 fades in (strokes only). */
export interface Track extends Paint {
  a: Float64Array;
  b: Float64Array;
  closed: boolean;
  fade: -1 | 0 | 1;
}

function align(a: Float64Array, b: Float64Array, closed: boolean): Float64Array {
  const n = a.length / 2;
  const at = (k: number, i: number, rev: boolean): number =>
    rev ? (closed ? (k - i + n) % n : n - 1 - i) : closed ? (i + k) % n : i;
  let best = { c: Infinity, k: 0, rev: false };
  for (const rev of [false, true])
    for (let k = 0; k < (closed ? n : 1); k++) {
      let c = 0;
      for (let i = 0; i < n && c < best.c; i++) {
        const j = at(k, i, rev);
        const dx = (a[2 * i] ?? 0) - (b[2 * j] ?? 0);
        const dy = (a[2 * i + 1] ?? 0) - (b[2 * j + 1] ?? 0);
        c += dx * dx + dy * dy;
      }
      if (c < best.c) best = { c, k, rev };
    }
  const out = new Float64Array(a.length);
  for (let i = 0; i < n; i++) {
    const j = at(best.k, i, best.rev);
    out[2 * i] = b[2 * j] ?? 0;
    out[2 * i + 1] = b[2 * j + 1] ?? 0;
  }
  return out;
}

/** Where an unmatched ring goes: fills flatten to a line through their centre, strokes shrink to a point. */
function vanish(r: Ring): Float64Array {
  const box = bounds(r.pts);
  const mx = (box.x0 + box.x1) / 2;
  const my = (box.y0 + box.y1) / 2;
  const out = new Float64Array(r.pts.length);
  for (let i = 0; i < out.length; i += 2) {
    out[i] = r.fill !== null ? mx + ((r.pts[i] ?? 0) - mx) * 0.5 : mx;
    out[i + 1] = my;
  }
  return out;
}

function bounds(pts: Float64Array): Box {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i] ?? 0;
    const y = pts[i + 1] ?? 0;
    b.x0 = Math.min(b.x0, x);
    b.x1 = Math.max(b.x1, x);
    b.y0 = Math.min(b.y0, y);
    b.y1 = Math.max(b.y1, y);
  }
  return b;
}

/** Tracks morphing shape `from` into `to`: rings of one paint matched by size, the rest fading. */
export function morph(from: Shape, to: Shape): Track[] {
  const tracks: Track[] = [];
  const keys = new Set([...from, ...to].map((r) => r.key));
  for (const key of keys) {
    const ra = from.filter((r) => r.key === key).sort((x, y) => y.size - x.size);
    const rb = to.filter((r) => r.key === key).sort((x, y) => y.size - x.size);
    for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
      const a = ra[i];
      const b = rb[i];
      if (a !== undefined && b !== undefined) {
        const closed = a.closed && b.closed;
        tracks.push({
          fill: a.fill,
          stroke: a.stroke,
          width: a.width,
          a: a.pts,
          b: align(a.pts, b.pts, closed),
          closed,
          fade: 0,
        });
      } else if (a !== undefined)
        tracks.push({
          fill: a.fill,
          stroke: a.stroke,
          width: a.width,
          a: a.pts,
          b: vanish(a),
          closed: a.closed,
          fade: -1,
        });
      else if (b !== undefined)
        tracks.push({
          fill: b.fill,
          stroke: b.stroke,
          width: b.width,
          a: vanish(b),
          b: b.pts,
          closed: b.closed,
          fade: 1,
        });
    }
  }
  // Fills behind strokes.
  return tracks.sort((x, y) => (x.stroke === null ? 0 : 1) - (y.stroke === null ? 0 : 1));
}

const f1 = (v: number): string => (Math.round(v * 10) / 10).toString();

/** A smooth curve (Catmull-Rom as cubic Béziers) through `p`, as SVG path data. */
export function curve(p: Float64Array, closed: boolean): string {
  const n = p.length / 2;
  const P = (i: number): [number, number] => {
    const j = closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i));
    return [p[2 * j] ?? 0, p[2 * j + 1] ?? 0];
  };
  let d = `M${f1(p[0] ?? 0)} ${f1(p[1] ?? 0)}`;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const [x0, y0] = P(i - 1);
    const [x1, y1] = P(i);
    const [x2, y2] = P(i + 1);
    const [x3, y3] = P(i + 2);
    d += `C${f1(x1 + (x2 - x0) / 6)} ${f1(y1 + (y2 - y0) / 6)} ${f1(x2 - (x3 - x1) / 6)} ${f1(y2 - (y3 - y1) / 6)} ${f1(x2)} ${f1(y2)}`;
  }
  return closed ? `${d}Z` : d;
}

// ---------- eyes and brows ----------

/** Boxes of a part's leaf shapes, each path subpath on its own. */
function leafBoxes(markup: string): Box[] {
  const out: Box[] = [];
  for (const [tag] of markup.matchAll(/<(path|circle|ellipse|rect)\b[^>]*>/g)) {
    if (!tag.startsWith("<path")) {
      const b = bbox(tag);
      if (b !== null) out.push(b);
      continue;
    }
    for (const sub of polylines(attrOf(tag, "d") ?? ""))
      out.push(bounds(Float64Array.from(sub.pts)));
  }
  return out.filter((b) => b.x1 - b.x0 + (b.y1 - b.y0) > 0);
}

const union = (bs: Box[]): Box => ({
  x0: Math.min(...bs.map((b) => b.x0)),
  y0: Math.min(...bs.map((b) => b.y0)),
  x1: Math.max(...bs.map((b) => b.x1)),
  y1: Math.max(...bs.map((b) => b.y1)),
});

/** One box per eye: the eye part's pieces split into two clusters at the widest horizontal gap. */
export function eyeBoxes(markup: string): Box[] {
  const bs = leafBoxes(markup).sort((a, b) => a.x0 + a.x1 - b.x0 - b.x1);
  if (bs.length < 2) return bs;
  const all = union(bs);
  let cut = 0;
  let gap = -Infinity;
  for (let i = 1; i < bs.length; i++) {
    const p = bs[i - 1];
    const q = bs[i];
    if (p === undefined || q === undefined) continue;
    const g = (q.x0 + q.x1) / 2 - (p.x0 + p.x1) / 2;
    if (g > gap) {
      gap = g;
      cut = i;
    }
  }
  return gap > 0.15 * (all.x1 - all.x0) ? [union(bs.slice(0, cut)), union(bs.slice(cut))] : [all];
}
