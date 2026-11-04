/**
 * Rows this app adds to an assistant thread that the host never wrote: a tool the header opens in
 * the thread (the avatar editor). They render like any assistant reply, after the host's messages,
 * and are not part of the transcript: Save or Cancel dismisses them, and so does leaving the
 * thread. Same idea as Relay desktop's `chat/local-rows.ts`.
 */
import { create } from "zustand";
import { toOpenUI, type AssistantMessage, type AssistantPortrait } from "@relay/protocol";

export const LOCAL_PREFIX = "local:";
const EDITOR_PREFIX = `${LOCAL_PREFIX}avatar-editor:`;

export const isLocalRow = (id: string): boolean => id.startsWith(LOCAL_PREFIX);

const NONE: AssistantMessage[] = [];

/** The assistant row holding an `openui` AvatarEditor fence for `agent`, the same reply the agent could write itself. */
export function avatarEditorRow(agent: string, current: AssistantPortrait, n: number, at: number): AssistantMessage {
  const program = toOpenUI({ widget: "avatarEditor", agent, current });
  return { id: `${EDITOR_PREFIX}${String(n)}`, role: "assistant", text: "```openui\n" + program + "\n```", at };
}

export interface LocalRowsStore {
  rows: Record<string, AssistantMessage[]>;
  /** Opens the editor in `agent`'s thread from its `current` portrait; one at a time, so a second call leaves it be. */
  openAvatarEditor: (agent: string, current: AssistantPortrait) => void;
  /** Removes the row `id` from `agent`'s thread; nothing happens for a row that is not there. */
  dismiss: (agent: string, id: string) => void;
  /** Forgets every local row of `agent` (its thread closed). */
  clear: (agent: string) => void;
}

let counter = 0;

export const useLocalRowsStore = create<LocalRowsStore>((set, get) => ({
  rows: {},
  openAvatarEditor: (agent, current) => {
    if (get().rows[agent]?.some((row) => row.id.startsWith(EDITOR_PREFIX)) === true) return;
    const row = avatarEditorRow(agent, current, ++counter, Date.now());
    set((state) => ({ rows: { ...state.rows, [agent]: [...(state.rows[agent] ?? []), row] } }));
  },
  dismiss: (agent, id) => {
    const rows = get().rows[agent];
    if (rows?.some((row) => row.id === id) !== true) return;
    set((state) => ({ rows: { ...state.rows, [agent]: (state.rows[agent] ?? []).filter((row) => row.id !== id) } }));
  },
  clear: (agent) => {
    if (get().rows[agent] === undefined) return;
    set((state) => ({ rows: Object.fromEntries(Object.entries(state.rows).filter(([key]) => key !== agent)) }));
  },
}));

/** `agent`'s local rows, oldest first. */
export function localRowsOf(state: Pick<LocalRowsStore, "rows">, agent: string): AssistantMessage[] {
  return state.rows[agent] ?? NONE;
}
