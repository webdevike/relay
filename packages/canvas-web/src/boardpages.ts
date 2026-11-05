// Pure helpers for a board's pages (canvas-live pages.ts) in the client: which page a participant
// is on, where a viewer goes when their page is deleted, the room bar's people grouped by page,
// the comments panel's rows across pages, the next "Page N" title and where a dragged page row
// lands. No DOM and no room, so tests call them directly.
import { FIRST_PAGE, type PageInfo } from "../../canvas-live/src/pages";
import type { Presence } from "../../canvas-live/src/shared";
import { type ThreadSnap, orderThreads } from "../../canvas-live/src/threads";

/** The page a participant is on (absent: page-1). */
export function presencePage(p: Pick<Presence, "page">): string {
  return p.page ?? FIRST_PAGE;
}

/** True when `p` is on `page`. */
export function onPage(p: Pick<Presence, "page">, page: string): boolean {
  return presencePage(p) === page;
}

/** The presences on `page` only, keyed as they came. */
export function statesOnPage<P extends Pick<Presence, "page">>(states: ReadonlyMap<number, P>, page: string): Map<number, P> {
  const out = new Map<number, P>();
  for (const [cid, p] of states) if (onPage(p, page)) out.set(cid, p);
  return out;
}

/**
 * Where a viewer on `current` goes once the page list changes from `prev` to `next`: `current`
 * while it is still there, else the nearest page that remains (the one after it first, then the
 * one before, moving outward), else the first page.
 */
export function fallbackPage(prev: readonly PageInfo[], next: readonly PageInfo[], current: string): string {
  const remains = new Set(next.map((p) => p.id));
  if (remains.has(current)) return current;
  const at = prev.findIndex((p) => p.id === current);
  if (at >= 0) {
    for (let d = 1; d < prev.length; d++) {
      for (const i of [at + d, at - d]) {
        const id = prev[i]?.id;
        if (id !== undefined && remains.has(id)) return id;
      }
    }
  }
  return next[0]?.id ?? FIRST_PAGE;
}

export interface PageGroup<P> {
  /** Null: people on a page the board no longer has (they are about to move). */
  page: PageInfo | null;
  people: P[];
}

/**
 * Presences grouped by the page they are on: the viewer's page first, then the others in page
 * order, then anyone on a page the board no longer has. Empty groups are left out.
 */
export function groupByPage<P extends Pick<Presence, "page">>(
  presences: Iterable<P>,
  pages: readonly PageInfo[],
  viewerPage: string,
): PageGroup<P>[] {
  const byPage = new Map<string, P[]>();
  const lost: P[] = [];
  const known = new Set(pages.map((p) => p.id));
  for (const p of presences) {
    const id = presencePage(p);
    if (!known.has(id)) {
      lost.push(p);
      continue;
    }
    const list = byPage.get(id);
    if (list === undefined) byPage.set(id, [p]);
    else list.push(p);
  }
  const order = [...pages.filter((p) => p.id === viewerPage), ...pages.filter((p) => p.id !== viewerPage)];
  const out: PageGroup<P>[] = [];
  for (const page of order) {
    const people = byPage.get(page.id);
    if (people !== undefined) out.push({ page, people });
  }
  if (lost.length > 0) out.push({ page: null, people: lost });
  return out;
}

/** A comment thread with the page it is on, for the comments panel. */
export interface ThreadRowItem {
  /** Unique across pages (thread ids are only unique on their page). */
  key: string;
  page: PageInfo;
  thread: ThreadSnap;
}

/** Every page's threads as one list: open ones then resolved ones, each newest activity first, whatever page they are on. */
export function threadRows(byPage: readonly { page: PageInfo; threads: readonly ThreadSnap[] }[]): {
  open: ThreadRowItem[];
  resolved: ThreadRowItem[];
} {
  const owner = new Map<ThreadSnap, PageInfo>();
  for (const { page, threads } of byPage) for (const t of threads) owner.set(t, page);
  const { open, resolved } = orderThreads([...owner.keys()]);
  const item = (thread: ThreadSnap): ThreadRowItem => {
    const page = owner.get(thread) ?? { id: FIRST_PAGE, title: "" };
    return { key: `${page.id}\t${thread.id}`, page, thread };
  };
  return { open: open.map(item), resolved: resolved.map(item) };
}

/** The title a new page gets: "Page <n>", n one past the page count, skipping titles already taken. */
export function nextPageTitle(pages: readonly PageInfo[]): string {
  const taken = new Set(pages.map((p) => p.title));
  let n = pages.length + 1;
  while (taken.has(`Page ${String(n)}`)) n++;
  return `Page ${String(n)}`;
}

/**
 * The index (`movePage`'s `to`) a page row dragged from `from` lands at when dropped on row `over`,
 * above it or `below` it.
 */
export function dropIndex(from: number, over: number, below: boolean): number {
  const at = over + (below ? 1 : 0);
  return from < at ? at - 1 : at;
}
