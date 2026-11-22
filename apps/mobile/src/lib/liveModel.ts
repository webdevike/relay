/**
 * Which 3D model view draws a live native SceneKit view: at most one in the whole app, the one
 * Isaac tapped. Each live view holds its own copy of its model (the GLB, the GLTFKit2 asset,
 * SceneKit geometry, GPU buffers, 4x MSAA drawables), so a thread whose models went live by
 * themselves got Relay killed at iOS's memory limit (2026-11-05, 2026-11-08, and on opening Nova's
 * thread with several 5 to 20 MB scans, 2026-11-22). Every other model is a poster.
 *
 * A tap opens a model (`open`); tapping another closes it. Whenever the transcript stops scrolling
 * (or every `SETTLE_MAX_WAIT_MS` during a long scroll), the open view measures how much of it is in
 * the screen's clear band (`viewportBand`: below the header, above the composer); once none of it
 * is, or its screen is covered by another, it closes. A view that closes unmounts its native view
 * (releasing the scene) and shows its poster.
 */
import { useCallback, useEffect, useId, useRef } from "react";
import { create } from "zustand";

/** Quiet time after the last scroll event before the open model checks it is still on screen. */
export const SETTLE_MS = 180;
/** A long, continuous scroll still checks this often. */
export const SETTLE_MAX_WAIT_MS = 600;
/** A poster snapshot is only cut from a model wholly inside the clear band, so it has no chrome in it. */
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

interface LiveModelStore {
  /** The open (live) view's id. */
  open: string | null;
  /** Counts settles: the open view tries a deferred poster again on each one. */
  rested: number;
}

export const useLiveModelStore = create<LiveModelStore>(() => ({ open: null, rested: 0 }));

/** What a mounted view tells the slot. */
export interface LiveModelEntry {
  /** Where the view is on screen now, or null when it cannot tell (not laid out). */
  measure: () => Promise<Visibility | null>;
  failed: boolean;
  /** Its screen is the focused one (a screen under another never keeps a model open). */
  focused: boolean;
}

const entries = new Map<string, LiveModelEntry>();
let timer: number | undefined;
let pendingSince: number | null = null;
let generation = 0;

/** Closes the open view once none of it is on screen (or it failed or its screen is covered); a newer settle supersedes a running one. */
export async function settle(): Promise<void> {
  const mine = ++generation;
  const { open } = useLiveModelStore.getState();
  const entry = open === null ? undefined : entries.get(open);
  const seen = entry === undefined || entry.failed || !entry.focused ? null : await entry.measure().catch(() => null);
  if (mine !== generation) return;
  if (useLiveModelStore.getState().open === open && (seen === null || seen.share <= 0)) useLiveModelStore.setState({ open: null });
  useLiveModelStore.setState((state) => ({ rested: state.rested + 1 }));
}

/** A scroll or layout change is waiting to settle: the list may be moving. */
export function settling(): boolean {
  return pendingSince !== null;
}

/**
 * Asks for a settle `SETTLE_MS` after the last request, but no later than `SETTLE_MAX_WAIT_MS`
 * after the first unsettled one, so a long scroll still closes a model scrolled away.
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
  useLiveModelStore.setState({ open: null, rested: 0 });
}

/** A mounted view (or its new state); the slot checks again. */
export function registerModel(id: string, entry: LiveModelEntry): void {
  entries.set(id, entry);
  requestSettle();
}

/** The view unmounted: it closes if it was open. */
export function unregisterModel(id: string): void {
  entries.delete(id);
  if (useLiveModelStore.getState().open === id) useLiveModelStore.setState({ open: null });
}

/** Isaac tapped `id`: it is the open model now, and any other closes. */
export function openModel(id: string): void {
  useLiveModelStore.setState({ open: id });
}

/** Registers a mounted view; answers whether it is the open one, the tap that opens it (closing any other), and (while open) the settle count. */
export function useLiveModel({ measure, failed, focused }: LiveModelEntry): { live: boolean; open: () => void; rested: number } {
  const id = useId();
  const live = useLiveModelStore((state) => state.open === id);
  const rested = useLiveModelStore((state) => (state.open === id ? state.rested : 0));
  const measureRef = useRef(measure);
  measureRef.current = measure;
  useEffect(() => {
    registerModel(id, { failed, focused, measure: () => measureRef.current() });
  }, [id, failed, focused]);
  useEffect(() => () => { unregisterModel(id); }, [id]);
  const open = useCallback(() => { openModel(id); }, [id]);
  return { live, open, rested };
}
