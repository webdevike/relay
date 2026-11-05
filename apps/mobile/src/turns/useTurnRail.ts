import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ViewToken } from "react-native";
import { buildTurns, turnKeysByBubble, type Turn, type TurnRow } from "@evaos/chat-core/turns";
import { bookmarksOf, useBookmarksStore } from "@/state/bookmarks";
import { useReactionsStore } from "@/state/reactions";
import { createBookmarker, registerBookmarker, type Bookmarker } from "./bookmarker";
import { viewableRange } from "./rail";

/** Rows count as on screen from the first sliver: the rail follows the top one. */
const VIEWABILITY = { itemVisiblePercentThreshold: 1 } as const;
const NONE: readonly string[] = [];

/**
 * Everything a thread screen needs of its turn rail: the turns of its rows (flagged by the thread's
 * reactions), the bookmarked ones, which rows are on screen, and a jump. Spread `viewable` onto the
 * inverted list that shows the rows (newest first); `rowCount` is how many it has.
 */
export function useTurnRail({
  turnRows,
  rowCount,
  thread,
  scrollToRow,
}: {
  /** The thread's rows oldest first, as `turns/rows.ts` makes them; `index` is a position among the list's `rowCount` rows. */
  turnRows: readonly TurnRow[];
  rowCount: number;
  /** The reaction thread (bookmarks and Isaac's reactions live under it); null while there is none. */
  thread: string | null;
  /** Scrolls the list so its row `flat` (0 = newest) sits at the top. */
  scrollToRow: (flat: number) => void;
}) {
  const reactions = useReactionsStore((state) =>
    thread === null ? undefined : state.threads[thread],
  );
  const keys = useBookmarksStore((state) => (thread === null ? NONE : bookmarksOf(state, thread)));
  const turns = useMemo(() => buildTurns(turnRows, reactions), [turnRows, reactions]);
  const bookmarks = useMemo(() => new Set(keys), [keys]);
  const turnOfBubble = useMemo(() => turnKeysByBubble(turnRows, turns), [turnRows, turns]);
  // The screen's bubble menus bookmark through this, by thread, always against the latest turns.
  const bookmarker = useRef<Bookmarker>(() => null);
  bookmarker.current = thread === null ? () => null : createBookmarker(thread, turnOfBubble, bookmarks);
  useEffect(() => (thread === null ? undefined : registerBookmarker(thread, (bubbleKey) => bookmarker.current(bubbleKey))), [thread]);
  const [rows, setRows] = useState<{ top: number; bottom: number } | null>(null);
  const rowCountRef = useRef(rowCount);
  rowCountRef.current = rowCount;
  // A FlatList needs one callback for its life, so it reads the live row count through a ref.
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const flat = viewableItems.flatMap((token) => (token.index === null ? [] : [token.index]));
    const next = viewableRange(flat, rowCountRef.current);
    setRows((prev) =>
      prev !== null && next !== null && prev.top === next.top && prev.bottom === next.bottom
        ? prev
        : next,
    );
  }).current;
  const jump = useCallback(
    (turn: Turn) => {
      scrollToRow(rowCountRef.current - 1 - turn.item);
    },
    [scrollToRow],
  );
  return {
    turns,
    bookmarks,
    rows,
    jump,
    viewable: { onViewableItemsChanged, viewabilityConfig: VIEWABILITY },
  };
}
