/**
 * Text a `relay://assistant/<id>?send=` or `?draft=` link hands to that assistant's thread
 * (`lib/appLinks.ts` `ThreadCompose`), in memory only. The thread screen (`app/eva.tsx`) takes it
 * once when it shows that agent: `send` goes out as Isaac's turn through the composer's own path,
 * anything else lands in the composer, unsent. Never a route param, so a URL from outside the app
 * cannot make the phone send; `+native-intent` only ever hands drafts.
 */
import { create } from "zustand";
import type { ThreadCompose } from "@/lib/appLinks";

interface ThreadHandoffState {
  /** By agent; a newer handoff to the same thread replaces one it has not taken yet. */
  handoffs: Record<string, ThreadCompose>;
  hand: (compose: ThreadCompose) => void;
  /** The thread's handoff, removed so it runs once; null when there is none. */
  take: (agent: string) => ThreadCompose | null;
}

export const useThreadHandoff = create<ThreadHandoffState>((set, get) => ({
  handoffs: {},
  hand: (compose) => {
    set((state) => ({ handoffs: { ...state.handoffs, [compose.agent]: compose } }));
  },
  take: (agent) => {
    const compose = get().handoffs[agent];
    if (compose === undefined) return null;
    set((state) => ({
      handoffs: Object.fromEntries(Object.entries(state.handoffs).filter(([key]) => key !== agent)),
    }));
    return compose;
  },
}));

/** A handed draft in a composer holding `draft`: on its own when that is empty, else after what Isaac typed (once). */
export function placeDraft(draft: string, text: string): string {
  if (draft.trim() === "") return text;
  if (draft.includes(text)) return draft;
  return `${draft}\n\n${text}`;
}
