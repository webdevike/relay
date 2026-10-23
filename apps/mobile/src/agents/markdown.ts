/**
 * A small, streaming-friendly Markdown parser for the transcript. Pure (no React Native)
 * so it stays testable in vitest. Covers the slice agents actually emit: headings, bold,
 * italic, strikethrough, inline code, links, fenced code, blockquotes, ordered and
 * unordered lists (nested), GitHub pipe tables, horizontal rules, and images. Anything it does
 * not recognise stays literal text.
 *
 * A fence still open at the end of the input (the agent is mid-stream) is treated as a
 * closed code block, so highlighting begins as soon as the fence line lands.
 */

import { parseWidget, type WidgetSpec } from "./widget";

export type Align = "left" | "center" | "right" | null;

export interface Inline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  href?: string;
}

export interface ListItem {
  blocks: Block[];
}

/** One markdown image: `![alt](src)`. */
export interface MessageImage {
  src: string;
  alt: string;
}

export type Block =
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "code"; lang: string | null; code: string; invalid: boolean }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "blockquote"; blocks: Block[] }
  | { kind: "table"; header: Inline[][]; align: Align[]; rows: Inline[][][] }
  | { kind: "widget"; spec: WidgetSpec }
  /** A ```openui fence: rendered live by its own runtime (OpenUIBlock), so it keeps the source.
   * `partial` while the fence is still open (the reply is streaming). */
  | { kind: "openui"; code: string; partial: boolean }
  | ({ kind: "image" } & MessageImage)
  | { kind: "hr" };

const FENCE = /^(`{3,}|~{3,})[ \t]*([\w+#.-]*)[^\n]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const HR = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const BLOCKQUOTE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|(\d+)[.)])[ \t]+(.*)$/;

/** Style flags carried down while parsing nested inline spans. */
interface Style {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  href?: string;
}

const EMPHASIS: { marker: string; word: boolean; apply: (s: Style) => Style }[] = [
  { marker: "**", word: false, apply: (s) => ({ ...s, bold: true }) },
  { marker: "__", word: true, apply: (s) => ({ ...s, bold: true }) },
  { marker: "~~", word: false, apply: (s) => ({ ...s, strike: true }) },
  { marker: "*", word: false, apply: (s) => ({ ...s, italic: true }) },
  { marker: "_", word: true, apply: (s) => ({ ...s, italic: true }) },
];

/**
 * Splits prose into styled runs. Handles inline code (literal inside), bold/italic/strike
 * emphasis, and `[label](url)` links, recursing so styles nest. Underscore emphasis only
 * fires at word boundaries so snake_case identifiers survive. Unbalanced markers stay literal.
 */
export function parseInline(text: string, style: Style = {}): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  let i = 0;
  const flush = () => {
    if (plain.length > 0) out.push({ text: plain, ...style });
    plain = "";
  };

  outer: while (i < text.length) {
    const c = text[i];

    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ text: text.slice(i + 1, end), code: true, ...(style.href !== undefined ? { href: style.href } : {}) });
        i = end + 1;
        continue;
      }
    }

    if (c === "[") {
      const link = matchLink(text, i);
      if (link) {
        flush();
        out.push(...parseInline(link.label, { ...style, href: link.href }));
        i = link.end;
        continue;
      }
    }

    if ((c === "h" || c === "H" || c === "w" || c === "W") && style.href === undefined) {
      const url = matchAutolink(text, i);
      if (url) {
        flush();
        out.push({ text: url.text, ...style, href: url.href });
        i = url.end;
        continue;
      }
    }

    for (const e of EMPHASIS) {
      if (!text.startsWith(e.marker, i)) continue;
      if (e.word && /\w/.test(text[i - 1] ?? "")) continue;
      const open = i + e.marker.length;
      if (/\s/.test(text[open] ?? " ")) continue;
      const end = text.indexOf(e.marker, open);
      if (end <= open) continue;
      if (/\s/.test(text[end - 1] ?? " ")) continue;
      if (e.word && /\w/.test(text[end + e.marker.length] ?? "")) continue;
      const inner = text.slice(open, end);
      flush();
      out.push(...parseInline(inner, e.apply(style)));
      i = end + e.marker.length;
      continue outer;
    }

    plain += c;
    i += 1;
  }

  flush();
  return out;
}

function matchLink(text: string, at: number): { label: string; href: string; end: number } | null {
  const close = text.indexOf("]", at + 1);
  if (close === -1 || text[close + 1] !== "(") return null;
  const paren = text.indexOf(")", close + 2);
  if (paren === -1) return null;
  const label = text.slice(at + 1, close);
  const href = text.slice(close + 2, paren).trim();
  if (label.includes("\n") || href.includes("\n") || href.length === 0) return null;
  return { label, href, end: paren + 1 };
}

const AUTOLINK = /^(?:https?:\/\/|www\.)[^\s<>()[\]{}]+(?:\([^\s<>()]*\))?[^\s<>()[\]{}]*/i;

/**
 * Matches a bare URL at `at` when it sits on a word boundary. Trailing sentence
 * punctuation is excluded from the link; a `www.` host gets an https scheme.
 */
function matchAutolink(text: string, at: number): { text: string; href: string; end: number } | null {
  const prev = text[at - 1];
  if (prev !== undefined && /[\w/@.:-]/.test(prev)) return null;
  const m = AUTOLINK.exec(text.slice(at));
  if (!m) return null;
  let raw = m[0];
  while (raw.length > 0 && /[.,;:!?'"]/.test(raw[raw.length - 1])) raw = raw.slice(0, -1);
  if (raw.length < 4) return null;
  const href = /^www\./i.test(raw) ? `https://${raw}` : raw;
  return { text: raw, href, end: at + raw.length };
}

/** Where an image `src` can be fetched from: any http(s) URL, a host drop path, or nowhere (a path on the Mac). */
export type ImageSrcKind = "remote" | "drop" | "local";

/** A drop path is exactly what `relay-linux share` prints: `/drops/<id>/<token>`. */
export function imageSrcKind(src: string): ImageSrcKind {
  if (/^https?:\/\//i.test(src)) return "remote";
  if (/^\/drops\/[^/]+\/[^/]+$/.test(src)) return "drop";
  return "local";
}

/** Last path segment of a local image `src` (a `file://` URL, query and percent-escapes included). */
export function imageBasename(src: string): string {
  const path = src.replace(/^file:\/\//i, "").replace(/[?#].*$/, "");
  const name = path.split("/").filter((s) => s !== "").pop() ?? "";
  try {
    return decodeURIComponent(name) || src;
  } catch {
    return name || src;
  }
}

/** `![alt](src)` at `at`: the destination may be `<wrapped>`, carry a title, or hold balanced parentheses. */
function matchImage(text: string, at: number): { alt: string; src: string; end: number } | null {
  if (!text.startsWith("![", at)) return null;
  const close = text.indexOf("]", at + 2);
  if (close === -1 || text[close + 1] !== "(") return null;
  let depth = 1;
  let j = close + 2;
  for (; j < text.length; j += 1) {
    const c = text[j];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  const alt = text.slice(at + 2, close);
  const dest = text.slice(close + 2, j).trim();
  if (alt.includes("\n") || dest.includes("\n")) return null;
  const m = /^<([^>]*)>|^(\S+)/.exec(dest);
  const src = (m?.[1] ?? m?.[2] ?? "").trim();
  if (src === "") return null;
  return { alt, src, end: j + 1 };
}

/**
 * Pulls `![alt](src)` images out of paragraph text (leaving code spans alone), since a Text can't
 * host one. A linked image `[![alt](src)](href)` counts as the image; the link is dropped.
 */
function extractImages(text: string): { rest: string; images: { src: string; alt: string }[] } {
  const images: { src: string; alt: string }[] = [];
  let rest = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        rest += text.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    let image = null as { alt: string; src: string; end: number } | null;
    if (c === "[" && text.startsWith("[![", i)) {
      const inner = matchImage(text, i + 1);
      if (inner && text[inner.end] === "]" && text[inner.end + 1] === "(") {
        const paren = text.indexOf(")", inner.end + 2);
        if (paren > inner.end + 2 && !text.slice(inner.end + 2, paren).includes("\n")) image = { ...inner, end: paren + 1 };
      }
    } else if (c === "!") {
      image = matchImage(text, i);
    }
    if (image) {
      images.push({ src: image.src, alt: image.alt });
      i = image.end;
      // Removing an image between two spaces must not leave a double one behind.
      if (/[ \t]$/.test(rest)) while (text[i] === " " || text[i] === "\t") i += 1;
      continue;
    }
    rest += c;
    i += 1;
  }
  return { rest, images };
}

/** Block-level parse of a whole message. */
export function parseBlocks(text: string): Block[] {
  return parseLines(text.split("\n"));
}

/**
 * The top-level images of a message, for a chat that shows them as tiles outside the text bubble,
 * and whether anything else is left to put in the bubble (`hasBody`).
 */
export function topLevelImages(text: string): { images: MessageImage[]; hasBody: boolean } {
  const images: MessageImage[] = [];
  let hasBody = false;
  for (const block of parseBlocks(text)) {
    if (block.kind === "image") images.push({ src: block.src, alt: block.alt });
    else hasBody = true;
  }
  return { images, hasBody };
}

function parseLines(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const [, marker = "", name = ""] = fence;
      const closer = marker.charAt(0);
      const body: string[] = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        const t = (lines[i] ?? "").trim();
        if (t.length >= 3 && t === closer.repeat(t.length)) {
          closed = true;
          i += 1;
          break;
        }
        body.push(lines[i] ?? "");
        i += 1;
      }
      const code = body.join("\n");
      const lang = name === "" ? null : name.toLowerCase();
      if (lang === "openui") {
        blocks.push({ kind: "openui", code, partial: !closed });
        continue;
      }
      const spec = lang === "ui" ? parseWidget(code) : null;
      // A still-streaming widget block is just unfinished, not invalid.
      const invalid = lang === "ui" && closed && !spec;
      blocks.push(spec ? { kind: "widget", spec } : { kind: "code", lang, code, invalid });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const [, hashes = "", rest = ""] = heading;
      blocks.push({ kind: "heading", level: hashes.length, inline: parseInline(rest) });
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    if (BLOCKQUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
      const m = BLOCKQUOTE.exec(lines[i] ?? "");
        if (!m) break;
        inner.push(m[1] ?? "");
        i += 1;
      }
      blocks.push({ kind: "blockquote", blocks: parseLines(inner) });
      continue;
    }

    const table = matchTable(lines, i);
    if (table) {
      blocks.push(table.block);
      i = table.next;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const list = parseList(lines, i);
      blocks.push(list.block);
      i = list.next;
      continue;
    }

    // Paragraph: consecutive lines until a blank or a line that starts another block.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (l.trim() === "") break;
      if (FENCE.test(l) || HEADING.test(l) || HR.test(l) || BLOCKQUOTE.test(l) || LIST_ITEM.test(l)) break;
      para.push(l);
      i += 1;
    }
    // An image becomes its own block after the paragraph's prose (nothing is left of an image-only one).
    const { rest, images } = extractImages(para.join("\n"));
    if (images.length === 0) {
      blocks.push({ kind: "paragraph", inline: parseInline(para.join("\n")) });
      continue;
    }
    const prose = rest
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .join("\n");
    if (prose !== "") blocks.push({ kind: "paragraph", inline: parseInline(prose) });
    for (const image of images) blocks.push({ kind: "image", src: image.src, alt: image.alt });
  }

  return blocks;
}

/** A row split into trimmed cells, tolerating optional leading and trailing pipes. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let k = 0; k < s.length; k += 1) {
    if (s[k] === "\\" && s[k + 1] === "|") {
      cur += "|";
      k += 1;
    } else if (s[k] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += s[k];
    }
  }
  cells.push(cur.trim());
  return cells;
}

const DELIM_CELL = /^:?-+:?$/;

function matchTable(lines: string[], start: number): { block: Block; next: number } | null {
  const header = lines[start] ?? "";
  const delim = lines[start + 1];
  if (delim === undefined || !header.includes("|")) return null;
  const delimCells = splitRow(delim);
  if (delimCells.length === 0 || !delimCells.every((c) => DELIM_CELL.test(c))) return null;

  const headerCells = splitRow(header);
  const align: Align[] = delimCells.map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });

  const rows: Inline[][][] = [];
  let i = start + 2;
  while (i < lines.length) {
    const row = lines[i] ?? "";
    if (row.trim() === "" || !row.includes("|")) break;
    rows.push(splitRow(row).map((c) => parseInline(c)));
    i += 1;
  }

  return {
    block: { kind: "table", header: headerCells.map((c) => parseInline(c)), align, rows },
    next: i,
  };
}

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = LIST_ITEM.exec(lines[start] ?? "");
  const baseIndent = (first?.[1] ?? "").length;
  const ordered = first?.[3] !== undefined;
  const startNum = ordered ? Number(first?.[3]) : 1;

  const items: ListItem[] = [];
  let current: string[] | null = null;
  let markerWidth = 0;
  let i = start;

  const commit = () => {
    if (current) items.push({ blocks: parseLines(current) });
    current = null;
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const m = LIST_ITEM.exec(line);
    const indent = m ? (m[1] ?? "").length : 0;

    if (m && indent === baseIndent) {
      commit();
      const marker = m[2] ?? "";
      markerWidth = indent + marker.length + 1;
      current = [m[4] ?? ""];
      i += 1;
      continue;
    }

    if (current === null) break;

    if (line.trim() === "") {
      // Blank line: part of the item only if the next line is indented into it.
      const next = lines[i + 1];
      if (next !== undefined && next.trim() !== "" && next.length - next.trimStart().length >= markerWidth) {
        current.push("");
        i += 1;
        continue;
      }
      break;
    }

    if (line.length - line.trimStart().length >= markerWidth) {
      current.push(line.slice(markerWidth));
      i += 1;
      continue;
    }

    break;
  }

  commit();
  return { block: { kind: "list", ordered, start: startNum, items }, next: i };
}

/**
 * The first line of a message as plain text, for a one-line preview: emphasis and code marks are
 * dropped, a link shows its label, an image shows as `Photo`. Empty when nothing is readable.
 */
export function previewText(text: string): string {
  for (const block of parseBlocks(text)) {
    const line = blockPreview(block);
    if (line !== "") return line;
  }
  return "";
}

function blockPreview(block: Block): string {
  switch (block.kind) {
    case "image":
      return "Photo";
    case "heading":
    case "paragraph":
      return inlinePreview(block.inline);
    case "list":
      return block.items.map((item) => item.blocks.map(blockPreview).find((line) => line !== "") ?? "").find((line) => line !== "") ?? "";
    case "blockquote":
      return block.blocks.map(blockPreview).find((line) => line !== "") ?? "";
    case "table":
      return block.header.map(inlinePreview).filter((cell) => cell !== "").join(" ");
    case "code":
      return "Code";
    case "widget":
    case "openui":
    case "hr":
      return "";
  }
}

function inlinePreview(runs: Inline[]): string {
  const joined = runs.map((run) => run.text).join("");
  return (
    joined
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}
