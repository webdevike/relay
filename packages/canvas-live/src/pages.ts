// Pages (Figma-style): a board holds one or more pages, each its own nodes, edges, comment threads
// and viewport. The first page, `page-1`, lives in the doc's original maps (`nodes`, `edges`,
// `threads`, meta `viewport`), so a board that never added a page is exactly what it always was;
// every other page gets maps of its own, keyed by its id. `meta.pages` holds the order and titles.
//
// Y.Doc:  meta.pages:            PageInfo[]   (absent: just page-1, titled "Page 1")
//         nodes:<pageId>         like `nodes`
//         edges:<pageId>         like `edges`
//         threads:<pageId>       like `threads`
//         meta["viewport:<pageId>"]   like meta `viewport`
// The board file keeps them under `pages` (board.ts).

import type * as Y from "yjs";
import { DOC_KEYS } from "./shared";
import type { ThreadMap } from "./threads";

/** The page in the doc's original maps (and the board file's top-level nodes, edges and threads). */
export const FIRST_PAGE = "page-1";
export const FIRST_PAGE_TITLE = "Page 1";
/** A page id: what the board file, the DSL (`@page <id>`) and the client all accept. */
export const PAGE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_PAGES = 100;
const MAX_TITLE = 200;

export interface PageInfo {
  id: string;
  title: string;
}

export interface PageMaps {
  nodes: Y.Map<Y.Map<unknown>>;
  edges: Y.Map<Y.Map<unknown>>;
  threads: Y.Map<ThreadMap>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The doc key of a page's map: the original key for page-1, `<key>:<pageId>` for the rest. */
export function pageKey(key: string, page: string): string {
  return page === FIRST_PAGE ? key : `${key}:${page}`;
}

/** A page's nodes, edges and threads. */
export function pageMaps(doc: Y.Doc, page: string): PageMaps {
  return {
    nodes: doc.getMap<Y.Map<unknown>>(pageKey(DOC_KEYS.nodes, page)),
    edges: doc.getMap<Y.Map<unknown>>(pageKey(DOC_KEYS.edges, page)),
    threads: doc.getMap<ThreadMap>(pageKey(DOC_KEYS.threads, page)),
  };
}

/** True for a board that has only page-1 under its default title: its file has no `pages`. */
export function isSinglePage(pages: readonly PageInfo[]): boolean {
  return pages.length === 1 && pages[0]?.id === FIRST_PAGE && pages[0].title === FIRST_PAGE_TITLE;
}

/** The board's pages in order; a board that never added one has just page-1. */
export function pagesOf(doc: Y.Doc): PageInfo[] {
  const v = doc.getMap<unknown>(DOC_KEYS.meta).get("pages");
  const seen = new Set<string>();
  const list: PageInfo[] = [];
  if (Array.isArray(v)) {
    for (const p of v as unknown[]) {
      if (!isObj(p) || typeof p["id"] !== "string" || typeof p["title"] !== "string" || !PAGE_ID.test(p["id"]) || seen.has(p["id"])) continue;
      seen.add(p["id"]);
      list.push({ id: p["id"], title: p["title"] });
    }
  }
  return list.length > 0 ? list : [{ id: FIRST_PAGE, title: FIRST_PAGE_TITLE }];
}

/** Writes the page list (none kept for a plain single page, so its file stays as it was). */
export function setPages(doc: Y.Doc, pages: readonly PageInfo[]): void {
  const meta = doc.getMap<unknown>(DOC_KEYS.meta);
  if (isSinglePage(pages)) {
    if (meta.has("pages")) meta.delete("pages");
  } else meta.set("pages", pages.map((p) => ({ id: p.id, title: p.title })));
}

/** A page title as stored: one trimmed line, capped; empty falls back to "Page <n>". */
export function cleanTitle(title: string, n: number): string {
  const t = title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  return t === "" ? `Page ${String(n)}` : t;
}

/** A fresh page id. */
export function newPageId(now = Date.now()): string {
  return `p-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Adds page `id` after `after` (default: last). False when the id is bad or taken, or the board is full. */
export function addPage(doc: Y.Doc, id: string, title: string, after?: string): boolean {
  const pages = pagesOf(doc);
  if (!PAGE_ID.test(id) || pages.some((p) => p.id === id) || pages.length >= MAX_PAGES) return false;
  const at = after === undefined ? pages.length : pages.findIndex((p) => p.id === after) + 1 || pages.length;
  pages.splice(at, 0, { id, title: cleanTitle(title, pages.length + 1) });
  doc.transact(() => {
    clearPage(doc, id);
    setPages(doc, pages);
  });
  return true;
}

/** Renames page `id`. False when there is no such page. */
export function renamePage(doc: Y.Doc, id: string, title: string): boolean {
  const pages = pagesOf(doc);
  const i = pages.findIndex((p) => p.id === id);
  const page = pages[i];
  if (page === undefined) return false;
  page.title = cleanTitle(title, i + 1);
  setPages(doc, pages);
  return true;
}

/** Moves page `id` to position `to` (clamped). False when there is no such page. */
export function movePage(doc: Y.Doc, id: string, to: number): boolean {
  const pages = pagesOf(doc);
  const i = pages.findIndex((p) => p.id === id);
  const page = pages[i];
  if (page === undefined) return false;
  pages.splice(i, 1);
  pages.splice(Math.max(0, Math.min(pages.length, Math.round(to))), 0, page);
  setPages(doc, pages);
  return true;
}

/** Empties a page's maps and its viewport. */
function clearPage(doc: Y.Doc, id: string): void {
  const maps = pageMaps(doc, id);
  maps.nodes.clear();
  maps.edges.clear();
  maps.threads.clear();
  const meta = doc.getMap<unknown>(DOC_KEYS.meta);
  const vk = pageKey("viewport", id);
  if (meta.has(vk)) meta.delete(vk);
}

/** Deletes page `id` and everything on it. False for the last page or an unknown one. */
export function deletePage(doc: Y.Doc, id: string): boolean {
  const pages = pagesOf(doc);
  if (pages.length <= 1 || !pages.some((p) => p.id === id)) return false;
  doc.transact(() => {
    clearPage(doc, id);
    setPages(
      doc,
      pages.filter((p) => p.id !== id),
    );
  });
  return true;
}
