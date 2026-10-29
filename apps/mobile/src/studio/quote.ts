/**
 * Prices for paid jobs. Quotes are free; the display ones are cached a minute per priced settings,
 * so flipping chips back and forth asks once. The confirm dialog always asks afresh
 * (`fetchQuote(spec, { fresh: true })`): what Isaac confirms is never a cached number.
 */
import { useEffect, useState } from "react";
import type { StudioSpec } from "@relay/protocol";
import { studioRequest } from "@/connection";
import { quoteKey } from "./draft";

const CACHE_MS = 60_000;
/** Settle time after a chip tap before asking, so a run of taps sends one quote. */
const DEBOUNCE_MS = 400;

export type Quote = { ok: true; credits: number; balance?: number | undefined } | { ok: false; error: string };

const cache = new Map<string, { quote: Quote; at: number }>();

export function cachedQuote(spec: StudioSpec): Quote | undefined {
  const hit = cache.get(quoteKey(spec));
  return hit !== undefined && Date.now() - hit.at < CACHE_MS ? hit.quote : undefined;
}

export async function fetchQuote(spec: StudioSpec, { fresh = false }: { fresh?: boolean } = {}): Promise<Quote> {
  const hit = fresh ? undefined : cachedQuote(spec);
  if (hit !== undefined) return hit;
  const result = await studioRequest({ kind: "quote", spec });
  const quote: Quote =
    result.ok && result.credits !== undefined ? { ok: true, credits: result.credits, balance: result.balance } : { ok: false, error: result.error ?? "No price from Higgsfield." };
  if (quote.ok) cache.set(quoteKey(spec), { quote, at: Date.now() });
  return quote;
}

/** The current settings' price, debounced; undefined while asking or for a free backend. */
export function useQuote(spec: StudioSpec | undefined, paid: boolean): Quote | undefined {
  const key = spec === undefined || !paid ? null : quoteKey(spec);
  const [answer, setAnswer] = useState<{ key: string; quote: Quote } | null>(null);
  useEffect(() => {
    if (key === null || spec === undefined) return;
    let live = true;
    const timer = setTimeout(() => {
      void fetchQuote(spec).then((quote) => {
        if (live) setAnswer({ key, quote });
      });
    }, cachedQuote(spec) === undefined ? DEBOUNCE_MS : 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // The spec is re-made every render; its priced settings are what matter.
  }, [key]);
  if (key === null) return undefined;
  return answer?.key === key ? answer.quote : spec === undefined ? undefined : cachedQuote(spec);
}
