/**
 * A small, streaming-friendly Markdown parser for the transcript. Pure (no React Native)
 * so it stays testable in vitest. Covers the slice agents actually emit: headings, bold,
 * italic, strikethrough, inline code, links, fenced code, blockquotes, ordered and
 * unordered lists (nested), GitHub pipe tables, and horizontal rules. Anything it does not
 * recognise stays literal text.
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

export type Block =
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "code"; lang: string | null; code: string }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "blockquote"; blocks: Block[] }
  | { kind: "table"; header: Inline[][]; align: Align[]; rows: Inline[][][] }
  | { kind: "widget"; spec: WidgetSpec }
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

/** Block-level parse of a whole message. */
export function parseBlocks(text: string): Block[] {
  return parseLines(text.split("\n"));
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
      while (i < lines.length) {
        const t = (lines[i] ?? "").trim();
        if (t.length >= 3 && t === closer.repeat(t.length)) {
          i += 1;
          break;
        }
        body.push(lines[i] ?? "");
        i += 1;
      }
      const code = body.join("\n");
      const lang = name === "" ? null : name.toLowerCase();
      const spec = lang === "ui" ? parseWidget(code) : null;
      blocks.push(spec ? { kind: "widget", spec } : { kind: "code", lang, code });
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
    blocks.push({ kind: "paragraph", inline: parseInline(para.join("\n")) });
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
