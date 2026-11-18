/**
 * The streamed reveal of a live page (a canvas component card): when a new revision of the code
 * draws, the elements it added or changed appear one after another, top to bottom in document
 * order, each with a short fade and rise, instead of the whole page swapping at once. Elements the
 * revision did not change stay put and never animate again.
 *
 * Every revision mounts a fresh React tree, so the diff is by structure, not by DOM node: before a
 * revision draws, `mark` models the page on screen (each element's shape, its own attributes and
 * text, a hash of its subtree); once it drew, `reveal` models the new page, matches each element's
 * children to the old ones (a weighted LCS: an identical subtree beats a same-shaped one), and
 * collects the reveal units. A unit is a new or changed element that reads as one thing: text, a
 * box (background, border, shadow), an image. A container with none of those (a Stack, a Group, a
 * grid) shows at once and its children become the units, so a grid's cards arrive one by one.
 *
 * A revision that lands while a reveal runs merges into it: elements still arriving keep their
 * place in the schedule (the animation continues on the new node from where it was) and the new
 * units queue after them. Motion is opacity and `translate` only (composited, no layout per frame)
 * through the Web Animations API with `fill: backwards`, applied before the first paint. Without
 * `animate` (reduced motion, nobody generating) the page swaps at once but still says what changed.
 */

/** One element of the page as the diff sees it. */
interface Shape {
  el: Element;
  /** Tag and class: what may match across revisions. */
  shape: string;
  /** Hash of its tag, stable attributes and own text. */
  own: number;
  /** Hash of `own` and every descendant. */
  hash: number;
  kids: Shape[];
  /** When its reveal started or starts (ms, `now`), while it is part of one. */
  start: number | undefined;
}

/** What a revision's reveal looks like: how many elements arrive, and when the last one is in. */
export interface RevealReport {
  units: number;
  /** From now until the last unit is in; 0 without motion. */
  ms: number;
}

/** One element's fade and rise. */
export const REVEAL_MS = 320;
/** The gap between two elements' starts. */
export const REVEAL_STEP_MS = 70;
/** The longest a revision's own stagger runs, however many elements it adds. */
const REVEAL_SPAN_MS = 1400;
const KEYFRAMES: Keyframe[] = [{ opacity: 0, translate: "0 6px", offset: 0 }];

/** Never part of the picture. */
const SKIP = new Set(["STYLE", "SCRIPT", "TEMPLATE", "LINK", "META", "NOSCRIPT"]);
/** Elements that are a picture of their own, never a container to look inside. */
const REPLACED = new Set([
  "IMG",
  "SVG",
  "CANVAS",
  "VIDEO",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "BUTTON",
  "IFRAME",
]);
/** Per-mount values (React ids) that change on every revision without changing anything. */
const VOLATILE = new Set([
  "id",
  "for",
  "name",
  "aria-labelledby",
  "aria-describedby",
  "aria-controls",
  "aria-owns",
  "aria-activedescendant",
  "aria-errormessage",
]);
/**
 * A React `useId` value (`_r_8_`, older `«r8»` and `:r8:`): per mount, so every revision has new
 * ones in the same places (Mantine's inline-style classes, label and SVG references).
 */
const REACT_ID = /_r_[0-9a-z]+_|«r[0-9a-z]+»|:r[0-9a-z]+:/g;

/** FNV-1a over `text`, continuing from `seed`. */
function fnv(text: string, seed = 0x811c9dc5): number {
  let h = seed;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The element's own text (its direct text nodes), trimmed. */
function ownText(el: Element): string {
  let text = "";
  for (const n of el.childNodes) if (n.nodeType === 3) text += n.nodeValue ?? "";
  return text.trim();
}

function model(el: Element, starts: WeakMap<Element, number>): Shape {
  let own = fnv(el.tagName);
  for (const a of [...el.attributes].sort((x, y) => (x.name < y.name ? -1 : 1))) {
    if (!VOLATILE.has(a.name)) own = fnv(`${a.name}=${a.value.replace(REACT_ID, "")};`, own);
  }
  own = fnv(ownText(el), own);
  const kids = modelKids(el, starts);
  let hash = own;
  for (const k of kids) hash = fnv(String(k.hash), hash);
  return {
    el,
    shape: `${el.tagName}.${(el.getAttribute("class") ?? "").replace(REACT_ID, "")}`,
    own,
    hash,
    kids,
    start: starts.get(el),
  };
}

function modelKids(el: Element, starts: WeakMap<Element, number>): Shape[] {
  const out: Shape[] = [];
  for (const k of el.children) if (!SKIP.has(k.tagName.toUpperCase())) out.push(model(k, starts));
  return out;
}

/** For each of `b`, its match in `a` (or null): an identical subtree scores 3, a same shape 1. */
function matchKids(a: readonly Shape[], b: readonly Shape[]): (Shape | null)[] {
  const n = a.length;
  const m = b.length;
  const out: (Shape | null)[] = b.map(() => null);
  if (n === 0 || m === 0) return out;
  const score = (x: Shape | undefined, y: Shape | undefined): number =>
    x === undefined || y === undefined ? 0 : x.hash === y.hash ? 3 : x.shape === y.shape ? 1 : 0;
  // A very long list pairs by position (the table would cost too much).
  if (n * m > 40_000) {
    b.forEach((y, j) => {
      const x = a[j];
      if (x !== undefined && score(x, y) > 0) out[j] = x;
    });
    return out;
  }
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  const at = (i: number, j: number): number => dp[i * w + j] ?? 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = score(a[i - 1], b[j - 1]);
      dp[i * w + j] = Math.max(at(i - 1, j), at(i, j - 1), s > 0 ? at(i - 1, j - 1) + s : 0);
    }
  }
  for (let i = n, j = m; i > 0 && j > 0;) {
    const x = a[i - 1];
    const s = score(x, b[j - 1]);
    if (x !== undefined && s > 0 && at(i, j) === at(i - 1, j - 1) + s) {
      out[j - 1] = x;
      i--;
      j--;
    } else if (at(i - 1, j) >= at(i, j - 1)) i--;
    else j--;
  }
  return out;
}

/**
 * A container: shows nothing of its own (no text, background, border or shadow) and holds
 * elements, so its children arrive one by one instead of it arriving whole.
 */
export function isContainer(el: Element): boolean {
  if (el.children.length === 0 || REPLACED.has(el.tagName.toUpperCase())) return false;
  if (ownText(el) !== "") return false;
  const s = getComputedStyle(el);
  if (s.display === "contents") return true;
  const bg = s.backgroundColor.replace(/\s/g, "");
  const clear = bg === "" || bg === "transparent" || /^rgba\(.*,0\)$/.test(bg);
  const borderless =
    [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].every(
      (v) => v === "" || parseFloat(v) === 0,
    ) ||
    [s.borderTopStyle, s.borderRightStyle, s.borderBottomStyle, s.borderLeftStyle].every(
      (v) => v === "" || v === "none" || v === "hidden",
    );
  return (
    clear && [s.backgroundImage, s.boxShadow].every((v) => v === "" || v === "none") && borderless
  );
}

interface Unit {
  el: Element;
  start: number | undefined;
}

/** A page's reveal: one per live page, fed `mark` before and `reveal` after each revision draws. */
export class PageStream {
  private prev: Shape[] | null = null;
  private readonly starts = new WeakMap<Element, number>();
  /** The start of the last element scheduled. */
  private last = -Infinity;

  constructor(
    private readonly root: Element,
    private readonly now: () => number = () => performance.now(),
    private readonly container: (el: Element) => boolean = isContainer,
  ) {}

  /** Models the page on screen: the next revision is diffed against it. */
  mark(): void {
    this.prev = modelKids(this.root, this.starts);
  }

  /** The revision on screen just drew: reveal what it added or changed. */
  reveal(animate: boolean): RevealReport {
    const t = this.now();
    const next = modelKids(this.root, this.starts);
    const units: Unit[] = [];
    const pending = (s: Shape): boolean => s.start !== undefined && s.start + REVEAL_MS > t;
    /** An unchanged subtree: elements of it still arriving keep arriving. */
    const carry = (o: Shape, n: Shape): void => {
      if (pending(o)) {
        units.push({ el: n.el, start: o.start });
        return;
      }
      o.kids.forEach((k, i) => {
        const nk = n.kids[i];
        if (nk) carry(k, nk);
      });
    };
    const visit = (n: Shape, o: Shape | null): void => {
      if (o !== null && o.hash === n.hash) {
        carry(o, n);
        return;
      }
      if (o !== null && pending(o)) {
        units.push({ el: n.el, start: o.start });
        return;
      }
      // New or changed and reads as one thing: it arrives whole. Else look inside.
      if (o?.own !== n.own && !this.container(n.el)) {
        units.push({ el: n.el, start: undefined });
        return;
      }
      kids(o?.kids ?? [], n.kids);
    };
    const kids = (a: Shape[], b: Shape[]): void => {
      const pairs = matchKids(a, b);
      b.forEach((n, i) => {
        visit(n, pairs[i] ?? null);
      });
    };
    kids(this.prev ?? [], next);
    this.prev = next;

    // New elements queue after the last one scheduled, in document order.
    const fresh = units.filter((u) => u.start === undefined).length;
    const step = fresh > 1 ? Math.min(REVEAL_STEP_MS, REVEAL_SPAN_MS / (fresh - 1)) : 0;
    let at = Math.max(t, this.last + REVEAL_STEP_MS);
    const timed = units.map(({ el, start }) => {
      if (start !== undefined) return { el, start };
      const s = at;
      at += step;
      return { el, start: s };
    });
    if (!animate || timed.length === 0) return { units: timed.length, ms: 0 };
    let end = t;
    for (const { el, start } of timed) {
      this.starts.set(el, start);
      this.last = Math.max(this.last, start);
      end = Math.max(end, start + REVEAL_MS);
      // Not every page has the Web Animations API (tests).
      if (typeof el.animate !== "function") continue;
      el.animate(KEYFRAMES, {
        duration: REVEAL_MS,
        delay: start - t,
        easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
        fill: "backwards",
      });
    }
    return { units: timed.length, ms: Math.round(end - t) };
  }
}
