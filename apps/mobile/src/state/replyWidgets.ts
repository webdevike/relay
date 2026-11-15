/**
 * Reply widgets (protocol "Reply widgets"): the ```openui block the widget agent picked for an
 * assistant's finished reply, by thread (`assistant:<id>`) and reply (`reactionKey`), shown under
 * the reply. Not persisted: the host owns them, a thread's screen asks with `widgets.get` when it
 * opens (and the driver again after every reconnect) on a host whose welcome offers
 * REPLY_WIDGETS_FEATURE, and the host pushes `widgets.snapshot` to every device when one is added.
 *
 * A block that arrives in a pushed snapshot is `fresh` until its reply draws it once (it slides in
 * then); the answer to the screen's own `widgets.get` (`asked`) is the thread as it was, drawn
 * still. `labelAnswer` is the host's answer to the 🎯 sheet (`widget.labeled`).
 */
import { create } from "zustand";
import { REPLY_WIDGETS_FEATURE, WIDGET_TRAINING_FEATURE, type ThreadWidgets } from "@relay/protocol";

export interface WidgetLabelAnswer {
  thread: string;
  message: string;
  ok: boolean;
  error?: string | undefined;
}

export interface ReplyWidgetsStore {
  /** The host keeps reply widgets (`welcome.features`); false while not connected. */
  widgetsUp: boolean;
  /** The host takes 🎯 labels (`welcome.features`); false while not connected. */
  trainingUp: boolean;
  threads: Record<string, ThreadWidgets>;
  /** Reply keys per thread whose block arrived live and has not been drawn yet. */
  fresh: Record<string, readonly string[]>;
  /** Threads with a `widgets.get` out: their next snapshot is the answer, drawn without motion. */
  asked: Record<string, true>;
  /** The host's last answer to a label; a new object for every answer. */
  labelAnswer: WidgetLabelAnswer | null;
  /** A welcome: what this host offers. */
  setFeatures: (features: readonly string[] | undefined) => void;
  /** The socket went: nothing can be asked or sent until the next welcome. */
  clearFeatures: () => void;
  /** `widgets.get` for `thread` went out. */
  ask: (thread: string) => void;
  /** The host's snapshot of `thread`, replacing whatever was shown for it. */
  set: (thread: string, widgets: ThreadWidgets) => void;
  /** Reply `key` of `thread` drew its fresh block: it never animates again. */
  settle: (thread: string, key: string) => void;
  labeled: (answer: WidgetLabelAnswer) => void;
  /** Forget every thread (another host). */
  clear: () => void;
}

/** The replies whose block is new or changed from `previous` to `next`. */
export function freshKeys(previous: ThreadWidgets | undefined, next: ThreadWidgets): string[] {
  return Object.keys(next).filter((key) => previous?.[key] !== next[key]);
}

function without<T>(map: Record<string, T>, thread: string): Record<string, T> {
  return Object.fromEntries(Object.entries(map).filter(([other]) => other !== thread));
}

export const useReplyWidgetsStore = create<ReplyWidgetsStore>((set) => ({
  widgetsUp: false,
  trainingUp: false,
  threads: {},
  fresh: {},
  asked: {},
  labelAnswer: null,
  setFeatures: (features) => {
    set({
      widgetsUp: features?.includes(REPLY_WIDGETS_FEATURE) === true,
      trainingUp: features?.includes(WIDGET_TRAINING_FEATURE) === true,
    });
  },
  clearFeatures: () => {
    set({ widgetsUp: false, trainingUp: false, asked: {} });
  },
  ask: (thread) => {
    set((state) => ({ asked: { ...state.asked, [thread]: true } }));
  },
  set: (thread, widgets) => {
    set((state) => {
      const answer = state.asked[thread] === true;
      const added = answer ? [] : freshKeys(state.threads[thread], widgets);
      const kept = (state.fresh[thread] ?? []).filter((key) => widgets[key] !== undefined && !added.includes(key));
      const fresh = [...kept, ...added];
      return {
        threads: { ...state.threads, [thread]: widgets },
        asked: answer ? without(state.asked, thread) : state.asked,
        fresh: fresh.length === 0 ? without(state.fresh, thread) : { ...state.fresh, [thread]: fresh },
      };
    });
  },
  settle: (thread, key) => {
    set((state) => {
      const keys = state.fresh[thread];
      if (keys?.includes(key) !== true) return {};
      const rest = keys.filter((other) => other !== key);
      return { fresh: rest.length === 0 ? without(state.fresh, thread) : { ...state.fresh, [thread]: rest } };
    });
  },
  labeled: (answer) => {
    set({ labelAnswer: { ...answer } });
  },
  clear: () => {
    set({ threads: {}, fresh: {}, asked: {}, labelAnswer: null });
  },
}));

/** The follow-up block under reply `key` of `thread`, or null; a selector-friendly read for one row. */
export function useReplyWidget(thread: string | null, key: string | null): string | null {
  return useReplyWidgetsStore((state) => (thread === null || key === null ? null : (state.threads[thread]?.[key] ?? null)));
}
