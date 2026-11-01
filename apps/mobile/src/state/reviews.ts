/**
 * Reviews as the phone last heard them from the host: the queue (pushed on every change), each
 * opened item's detail (PR, its Guide, Linear ticket, Slack thread) and every item's Astra session
 * by url. Not persisted: the host owns all of it and the driver asks for the queue on every
 * (re)connection; a detail screen asks for its item when it opens.
 *
 * `useReviewTicksStore` is the one local piece: the Guide's reviewed-file ticks, per PR head
 * commit, kept on the phone like the other persisted settings (a new push starts a fresh list).
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AstraItem, LinearTicket, ReviewGuide, ReviewPr, ReviewQueue, SlackThread } from "@relay/protocol";
import { askLanded, pendingAsk, type PendingAsk } from "@/reviews/model";
import { fileStorage } from "./storage";

/** `owner/repo#170`: one PR's key in the detail caches and the ticks. */
export function prKey(repo: string, number: number): string {
  return `${repo}#${String(number)}`;
}

/** A Slack thread (or a DM outside a thread) by channel and thread ts. */
export function threadKey(channel: string, threadTs: string | null): string {
  return `${channel}/${threadTs ?? ""}`;
}

export interface ReviewsStore {
  /** Null until the host's first answer. */
  queue: ReviewQueue | null;
  prs: Record<string, ReviewPr>;
  guides: Record<string, ReviewGuide>;
  tickets: Record<string, LinearTicket>;
  /** A thread the host has not read yet is `null`. */
  threads: Record<string, SlackThread | null>;
  astra: Record<string, AstraItem>;
  /** Asks sent from an item's composer that its session does not show yet, by item url. */
  asks: Record<string, PendingAsk>;
  setQueue: (queue: ReviewQueue) => void;
  /** Done marks from a `done` answer (the host's whole record). */
  setDone: (done: Record<string, number>) => void;
  /** Hides (or with `done` false shows) a row at once, before the host confirms. */
  markDone: (url: string, updatedAt: number, done: boolean) => void;
  setPr: (pr: ReviewPr) => void;
  setGuide: (key: string, guide: ReviewGuide) => void;
  setTicket: (ticket: LinearTicket) => void;
  setThread: (key: string, thread: SlackThread | null) => void;
  /** A session snapshot; an ask it now shows is no longer pending. */
  setAstra: (item: AstraItem) => void;
  /** Isaac just asked `text` on item `url`: shown at once, until the session shows it. */
  ask: (url: string, text: string) => void;
  /** The ask failed or was refused; the panel shows the error instead. */
  dropAsk: (url: string) => void;
  /** Another host: everything this one said goes. */
  clear: () => void;
}

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

export const useReviewsStore = create<ReviewsStore>((set, get) => ({
  queue: null,
  prs: {},
  guides: {},
  tickets: {},
  threads: {},
  astra: {},
  asks: {},
  setQueue: (queue) => {
    set({ queue });
  },
  setDone: (done) => {
    const queue = get().queue;
    if (queue !== null) set({ queue: { ...queue, done } });
  },
  markDone: (url, updatedAt, done) => {
    const queue = get().queue;
    if (queue === null) return;
    const next = Object.fromEntries(Object.entries(queue.done).filter(([key]) => key !== url));
    if (done) next[url] = updatedAt;
    set({ queue: { ...queue, done: next } });
  },
  setPr: (pr) => {
    set({ prs: { ...get().prs, [prKey(pr.repo, pr.number)]: pr } });
  },
  setGuide: (key, guide) => {
    set({ guides: { ...get().guides, [key]: guide } });
  },
  setTicket: (ticket) => {
    set({ tickets: { ...get().tickets, [ticket.key]: ticket } });
  },
  setThread: (key, thread) => {
    set({ threads: { ...get().threads, [key]: thread } });
  },
  setAstra: (item) => {
    const { astra, asks } = get();
    const asked = asks[item.url];
    const landed = asked !== undefined && askLanded(item, asked);
    set({ astra: { ...astra, [item.url]: item }, asks: landed ? withoutKey(asks, item.url) : asks });
  },
  ask: (url, text) => {
    set({ asks: { ...get().asks, [url]: pendingAsk(get().astra[url], text) } });
  },
  dropAsk: (url) => {
    set({ asks: withoutKey(get().asks, url) });
  },
  clear: () => {
    set({ queue: null, prs: {}, guides: {}, tickets: {}, threads: {}, astra: {}, asks: {} });
  },
}));

export interface ReviewTicksStore {
  /** Reviewed file paths by `prKey@headSha`. */
  ticks: Record<string, string[]>;
  toggle: (pr: string, headSha: string, path: string) => void;
}

/** The ticks' key: one PR at one head commit. */
export function ticksKey(pr: string, headSha: string): string {
  return `${pr}@${headSha}`;
}

const NO_TICKS: string[] = [];

/** Reviewed paths of `pr` at `headSha`; one stable empty list for store selectors. */
export function ticksOf(ticks: Record<string, string[]>, pr: string, headSha: string): string[] {
  return ticks[ticksKey(pr, headSha)] ?? NO_TICKS;
}

export const useReviewTicksStore = create<ReviewTicksStore>()(
  persist(
    (set) => ({
      ticks: {},
      toggle: (pr, headSha, path) => {
        set((state) => {
          const key = ticksKey(pr, headSha);
          // An older head of the same PR is stale once a newer one is ticked.
          const kept = Object.fromEntries(Object.entries(state.ticks).filter(([k]) => !k.startsWith(`${pr}@`) || k === key));
          const current = kept[key] ?? [];
          kept[key] = current.includes(path) ? current.filter((p) => p !== path) : [...current, path];
          return { ticks: kept };
        });
      },
    }),
    { name: "relay-review-ticks", storage: createJSONStorage(() => fileStorage) },
  ),
);
