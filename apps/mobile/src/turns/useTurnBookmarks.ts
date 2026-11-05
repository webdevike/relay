import { useEffect, useMemo, useRef } from "react";
import { buildTurns, turnKeysByBubble, type TurnRow } from "@evaos/chat-core/turns";
import { bookmarksOf, useBookmarksStore } from "@/state/bookmarks";
import { useReactionsStore } from "@/state/reactions";
import { createBookmarker, registerBookmarker, type Bookmarker } from "./bookmarker";

const NONE: readonly string[] = [];

/**
 * Lets a thread screen's bubble long-press menus bookmark their turn ("Bookmark Turn"): registers
 * the screen's bookmarker under its reaction thread, always against the latest turns (flagged by the
 * thread's reactions) and bookmarks. `turnRows` are the thread's rows oldest first, as `turns/rows.ts`
 * makes them.
 */
export function useTurnBookmarks({
  turnRows,
  thread,
}: {
  turnRows: readonly TurnRow[];
  /** The reaction thread (bookmarks and Isaac's reactions live under it); null while there is none. */
  thread: string | null;
}): void {
  const reactions = useReactionsStore((state) =>
    thread === null ? undefined : state.threads[thread],
  );
  const keys = useBookmarksStore((state) => (thread === null ? NONE : bookmarksOf(state, thread)));
  const turns = useMemo(() => buildTurns(turnRows, reactions), [turnRows, reactions]);
  const bookmarks = useMemo(() => new Set(keys), [keys]);
  const turnOfBubble = useMemo(() => turnKeysByBubble(turnRows, turns), [turnRows, turns]);
  const bookmarker = useRef<Bookmarker>(() => null);
  bookmarker.current = thread === null ? () => null : createBookmarker(thread, turnOfBubble, bookmarks);
  useEffect(() => (thread === null ? undefined : registerBookmarker(thread, (bubbleKey) => bookmarker.current(bubbleKey))), [thread]);
}
