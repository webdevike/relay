/**
 * Which 3D model views draw a live native SceneKit view. Each live view holds its own copy of its
 * model (the GLB, the GLTFKit2 asset, SceneKit geometry, GPU buffers, 4x MSAA drawables) and an
 * auto-rotating one redraws at the display rate, so a thread with several scanned-room models that
 * kept them all live got Relay killed at iOS's 3.5 GB limit (2026-11-05, 2026-11-08).
 *
 * The live slot follows the viewport: whenever the transcript stops scrolling (or every
 * `SETTLE_MAX_WAIT_MS` during a long scroll), every mounted model view measures how much of it is
 * in the screen's clear band (`viewportBand`: below the header, above the composer), and the most
 * visible one (`FOCUS_MIN_SHARE` of it or more) takes the focus slot; the one holding it keeps it
 * unless another shows clearly more (`HOLD_BONUS`), and equal ones go to the newest message
 * (`ModelRank`). A tap takes the slot at once and keeps it while that model is on screen at all.
 * With `LIVE_SLOTS` 2 the second slot makes posters: the most visible model wholly in the band with
 * no poster yet loads, is snapshotted (`lib/modelPosters.ts`) and gives the slot to the next one. A
 * view that loses the slot unmounts its native view (releasing the scene) and shows its poster.
 */
import { createContext, useCallback, useContext, useEffect, useId, useRef } from "react";
import { create } from "zustand";

/** The message's time (epoch ms) for the models inside it; equally visible models go newest first. */
export const ModelRank = createContext(0);

/** Native views live at once: the focus slot, plus one that makes posters for the rest. */
export const LIVE_SLOTS = 2;
/** The focus slot needs at least this share of a model's frame on screen. */
export const FOCUS_MIN_SHARE = 0.35;
/** The focus holder keeps the slot unless another shows this much more of itself (area). */
export const HOLD_BONUS = 1.25;
/** Quiet time after the last scroll event before the slot moves. */
export const SETTLE_MS = 180;
/** A long, continuous scroll still moves the slot this often. */
export const SETTLE_MAX_WAIT_MS = 600;
/** The poster slot only takes a model wholly inside the clear band, so its snapshot has no chrome in it. */
export const POSTER_MIN_SHARE = 0.99;
/** Screen chrome over a transcript (frosted header with its chips; composer, card or scroll button), pt. */
const TOP_CHROME = 120;
const BOTTOM_CHROME = 200;

/** How much of a model view is in the clear band. */
export interface Visibility {
  /** Visible area, pt². */
  area: number;
  /** Visible area over the view's own area, 0 to 1. */
  share: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The window rows no header or composer covers, in window coordinates. */
export interface Band {
  top: number;
  bottom: number;
  width: number;
}

/** The clear band of a window with these safe-area insets. */
export function viewportBand(window: { width: number; height: number }, insets: { top: number; bottom: number }): Band {
  return { top: insets.top + TOP_CHROME, bottom: window.height - insets.bottom - BOTTOM_CHROME, width: window.width };
}

/** The part of `rect` (window coordinates) inside the `band`. */
export function visibility(rect: Rect, band: Band): Visibility {
  const own = rect.width * rect.height;
  if (own <= 0) return { area: 0, share: 0 };
  const w = Math.max(0, Math.min(rect.x + rect.width, band.width) - Math.max(rect.x, 0));
  const h = Math.max(0, Math.min(rect.y + rect.height, band.bottom) - Math.max(rect.y, band.top));
  const area = w * h;
  return { area, share: area / own };
}

/** A mounted model view, as the slot assignment sees it. */
export interface Candidate extends Visibility {
  id: string;
  rank: number;
  /** It has a poster (a snapshot or the drop's own), so it never needs the poster slot. */
  poster: boolean;
}

export interface Slots {
  /** Live view ids: the focus slot first, then the poster slot. */
  live: readonly string[];
  /** The view Isaac tapped, holding the focus slot while it is on screen. */
  pinned: string | null;
}

const byVisibility = (hold: string | undefined) => (a: Candidate, b: Candidate) => {
  const score = (c: Candidate) => c.area * (c.id === hold ? HOLD_BONUS : 1);
  return score(b) - score(a) || b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
};

/**
 * Pure slot assignment from what is mounted and visible now. Views not in `candidates` (unmounted,
 * failed, on a covered screen) hold no slot. With nothing on screen enough to take focus, the focus
 * holder keeps it rather than reloading something later.
 */
export function assignSlots(candidates: readonly Candidate[], current: Slots, capacity: number = LIVE_SLOTS): Slots {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const pinnedNow = current.pinned === null ? undefined : byId.get(current.pinned);
  const pinned = pinnedNow !== undefined && pinnedNow.share > 0 ? pinnedNow.id : null;
  const hold = current.live[0];
  const ranked = [...candidates].sort(byVisibility(hold));
  const focus = pinned ?? ranked.find((c) => c.share >= FOCUS_MIN_SHARE)?.id ?? (hold !== undefined && byId.has(hold) ? hold : undefined);
  if (focus === undefined || capacity <= 0) return { live: [], pinned };
  const live = [focus];
  if (capacity > 1) {
    // The poster slot stays on the model it is already making a poster for, so it is not cut short.
    const posterHolder = current.live[1] === undefined ? undefined : byId.get(current.live[1]);
    const needs = (c: Candidate) => c.id !== focus && !c.poster && c.share >= POSTER_MIN_SHARE;
    const maker = posterHolder !== undefined && needs(posterHolder) ? posterHolder : ranked.find(needs);
    if (maker !== undefined) live.push(maker.id);
  }
  return { live, pinned };
}

interface LiveModelStore extends Slots {
  /** Counts settles: a live view tries a deferred poster again on each one. */
  rested: number;
  set: (slots: Slots) => void;
}

export const useLiveModelStore = create<LiveModelStore>((set, get) => ({
  live: [],
  pinned: null,
  rested: 0,
  set: ({ live, pinned }) => {
    const now = get();
    if (now.pinned !== pinned || now.live.length !== live.length || now.live.some((id, i) => live[i] !== id)) set({ live, pinned });
  },
}));

/** What a mounted view tells the slot. */
interface Entry {
  rank: number;
  measure: () => Promise<Visibility | null>;
  poster: boolean;
  failed: boolean;
  /** Its screen is the focused one (a screen under another never takes a slot). */
  focused: boolean;
}

const entries = new Map<string, Entry>();
let timer: number | undefined;
let pendingSince: number | null = null;
let generation = 0;

/** Measures every eligible view and moves the slots; a newer settle supersedes a running one. */
export async function settle(): Promise<void> {
  const mine = ++generation;
  const eligible = [...entries].filter(([, entry]) => !entry.failed && entry.focused);
  const measured = await Promise.all(
    eligible.map(async ([id, entry]): Promise<Candidate | null> => {
      const seen = await entry.measure().catch(() => null);
      return seen === null ? null : { id, rank: entry.rank, poster: entry.poster, ...seen };
    }),
  );
  if (mine !== generation) return;
  const store = useLiveModelStore.getState();
  // Views that unmounted while measuring are gone from `entries`.
  const candidates = measured.filter((c): c is Candidate => c !== null && entries.has(c.id));
  store.set(assignSlots(candidates, store));
  useLiveModelStore.setState((state) => ({ rested: state.rested + 1 }));
}

/** A scroll or layout change is waiting to settle: the list may be moving. */
export function settling(): boolean {
  return pendingSince !== null;
}

/**
 * Asks for a settle `SETTLE_MS` after the last request, but no later than `SETTLE_MAX_WAIT_MS`
 * after the first unsettled one, so a long scroll still moves the slot along.
 */
export function requestSettle(): void {
  const now = Date.now();
  pendingSince ??= now;
  clearTimeout(timer);
  timer = setTimeout(() => {
    pendingSince = null;
    void settle();
  }, Math.max(0, Math.min(SETTLE_MS, pendingSince + SETTLE_MAX_WAIT_MS - now)));
}

/** Test reset. */
export function resetLiveModels(): void {
  entries.clear();
  clearTimeout(timer);
  pendingSince = null;
  generation = 0;
  useLiveModelStore.setState({ live: [], pinned: null, rested: 0 });
}

export interface LiveModelInput {
  /** Where the view is on screen now, or null when it cannot tell (not laid out). */
  measure: () => Promise<Visibility | null>;
  poster: boolean;
  failed: boolean;
  focused: boolean;
}

/** Registers a mounted view; answers whether it may draw its native view, the tap that makes it live, and (while live) the settle count. */
export function useLiveModel({ measure, poster, failed, focused }: LiveModelInput): { live: boolean; activate: () => void; rested: number } {
  const id = useId();
  const rank = useContext(ModelRank);
  const live = useLiveModelStore((state) => state.live.includes(id));
  const rested = useLiveModelStore((state) => (state.live.includes(id) ? state.rested : 0));
  const measureRef = useRef(measure);
  measureRef.current = measure;
  useEffect(() => {
    entries.set(id, { rank, poster, failed, focused, measure: () => measureRef.current() });
    requestSettle();
  }, [id, rank, poster, failed, focused]);
  useEffect(
    () => () => {
      entries.delete(id);
      const { live: held, pinned, set } = useLiveModelStore.getState();
      if (held.includes(id) || pinned === id) set({ live: held.filter((other) => other !== id), pinned: pinned === id ? null : pinned });
      requestSettle();
    },
    [id],
  );
  const activate = useCallback(() => {
    const { live: held, set } = useLiveModelStore.getState();
    set({ live: [id, ...held.slice(1).filter((other) => other !== id)].slice(0, LIVE_SLOTS), pinned: id });
  }, [id]);
  return { live, activate, rested };
}
