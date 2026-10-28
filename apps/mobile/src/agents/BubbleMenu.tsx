/**
 * Reactions and the long-press menu on chat bubbles, wired for a whole chat screen (the Eva thread
 * and a regular session alike). `BubbleMenuProvider` wraps the screen: it follows the thread's
 * reactions while mounted (`watchReactions`), and draws the `BubbleContextOverlay` over everything
 * plus the "more" emoji sheet and the Select Text sheet. Each user or assistant bubble renders
 * inside a `ChatBubble`, which makes it a `ReactableBubble` with its badge.
 *
 * Tapping an emoji toggles it (`toggleReaction`: the same one takes it back) with a selection
 * haptic and sends it (`react`); offline nothing changes and a warning haptic says so. Reply hands
 * the bubble's text to the screen (`onReply`), which quotes it into its composer
 * (`lib/bubbleMenu.ts` `quoteIntoDraft`); Copy, Select Text and Share act on the text without its
 * surface tag.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Keyboard, Share, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { toggleReaction, untagged } from "@relay/protocol";
import { react, watchReactions } from "@/connection";
import { useBubbleReaction, useReactionsStore } from "@/state/reactions";
import type { Rect } from "@/lib/bubbleMenu";
import { copyText } from "@/lib/clipboard";
import { notifyHaptic, selectHaptic, tapHaptic } from "@/lib/haptics";
import { warn } from "@/connection/log";
import { BubbleContextOverlay } from "@/ui/BubbleContextOverlay";
import { EmojiPickerSheet } from "@/ui/EmojiPickerSheet";
import type { MessageMenuAction } from "@/ui/MessageMenu";
import { ReactableBubble } from "@/ui/ReactableBubble";
import { SelectTextSheet } from "@/ui/SelectTextSheet";

/** A card drawn behind a lifted reply that has no bubble of its own. */
export interface LiftCard {
  fill: string;
  radius: number;
  inset: number;
}

interface OpenBubble {
  key: string;
  side: "left" | "right";
  text: string;
  rect: Rect;
  lifted: ReactNode;
  radius: number;
  card: LiftCard | undefined;
}

interface BubbleMenuContextValue {
  thread: string | null;
  openKey: string | null;
  open: (bubble: OpenBubble) => void;
}

const BubbleMenuContext = createContext<BubbleMenuContextValue | null>(null);

export interface BubbleMenuProviderProps {
  /** The reaction thread on screen (`assistantReactionThread` / `sessionReactionThread`); null while there is none. */
  thread: string | null;
  /** Reply: the bubble's text (surface tag dropped) to quote into the composer. */
  onReply: (text: string) => void;
  children: ReactNode;
}

export function BubbleMenuProvider({ thread, onReply, children }: BubbleMenuProviderProps) {
  const [open, setOpen] = useState<OpenBubble | null>(null);
  const [picking, setPicking] = useState<{ key: string; text: string } | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);
  useEffect(() => (thread === null ? undefined : watchReactions(thread)), [thread]);
  const shownKey = open?.key ?? picking?.key ?? null;
  const current = useBubbleReaction(thread, shownKey);

  const choose = useCallback(
    (key: string, text: string, emoji: string) => {
      if (thread === null) return;
      const had = useReactionsStore.getState().threads[thread]?.[key]?.emoji ?? null;
      if (react(thread, key, toggleReaction(had, emoji), text)) selectHaptic();
      else notifyHaptic("warning");
    },
    [thread],
  );
  const value = useMemo<BubbleMenuContextValue>(
    () => ({
      thread,
      openKey: open?.key ?? null,
      open: (bubble) => {
        Keyboard.dismiss();
        setOpen(bubble);
      },
    }),
    [thread, open?.key],
  );

  const close = (): void => {
    setOpen(null);
  };
  const actions = (bubble: OpenBubble): MessageMenuAction[] => {
    const text = untagged(bubble.text).trim();
    return [
      {
        key: "reply",
        label: "Reply",
        symbol: "arrowshape.turn.up.left",
        onPress: () => {
          setOpen(null);
          onReply(text);
        },
      },
      {
        key: "copy",
        label: "Copy",
        symbol: "doc.on.doc",
        onPress: () => {
          setOpen(null);
          tapHaptic();
          copyText(text).catch((error: unknown) => {
            warn("reactions", "copy failed", error);
          });
        },
      },
      {
        key: "select",
        label: "Select Text",
        symbol: "selection.pin.in.out",
        onPress: () => {
          setOpen(null);
          setSelecting(text);
        },
      },
      {
        key: "share",
        label: "Share",
        symbol: "square.and.arrow.up",
        onPress: () => {
          setOpen(null);
          Share.share({ message: text }).catch((error: unknown) => {
            warn("reactions", "share failed", error);
          });
        },
      },
    ];
  };

  return (
    <BubbleMenuContext.Provider value={value}>
      <View style={styles.fill}>
        {children}
        {open !== null && (
          <BubbleContextOverlay
            bubble={open.rect}
            side={open.side}
            lifted={open.lifted}
            radius={open.radius}
            card={open.card}
            reaction={current}
            onReact={(emoji) => {
              setOpen(null);
              choose(open.key, open.text, emoji);
            }}
            onMore={() => {
              setOpen(null);
              setPicking({ key: open.key, text: open.text });
            }}
            actions={actions(open)}
            onClose={close}
          />
        )}
      </View>
      <EmojiPickerSheet
        visible={picking !== null}
        current={picking === null ? null : current}
        onPick={(emoji) => {
          if (picking !== null) choose(picking.key, picking.text, emoji);
          setPicking(null);
        }}
        onClose={() => {
          setPicking(null);
        }}
      />
      <SelectTextSheet
        text={selecting}
        onClose={() => {
          setSelecting(null);
        }}
      />
    </BubbleMenuContext.Provider>
  );
}

export interface ChatBubbleProps {
  /** The bubble's reaction key (`lib/reactions.ts` `bubbleReactionKey`); null when it takes no reaction. */
  messageKey: string | null;
  /** The agent's bubbles hug the left, Isaac's the right. */
  side: "left" | "right";
  /** The message text, for the excerpt, Reply, Copy, Select Text and Share. */
  text: string;
  /** The bubble's layout (alignSelf, maxWidth); its look stays on the child. */
  style?: StyleProp<ViewStyle>;
  /** The bubble's corner radius. */
  radius: number;
  /** A card behind the lifted copy, for a reply without a bubble of its own. */
  card?: LiftCard | undefined;
  /** The page colour around the bubble (the badge's ring). */
  ring: string;
  /** One VoiceOver element with this label; omit when the bubble holds links or controls. */
  accessibilityLabel?: string | undefined;
  children: ReactNode;
}

/** One reactable chat bubble; outside a `BubbleMenuProvider`, or for a null key, a plain view. */
export function ChatBubble({ messageKey, side, text, style, radius, card, ring, accessibilityLabel, children }: ChatBubbleProps) {
  const context = useContext(BubbleMenuContext);
  const thread = context?.thread ?? null;
  const reaction = useBubbleReaction(thread, messageKey);
  const enabled = context !== null && thread !== null && messageKey !== null;
  return (
    <ReactableBubble
      style={style}
      side={side}
      reaction={reaction}
      enabled={enabled}
      lifted={enabled && context.openKey === messageKey}
      ring={ring}
      accessibilityLabel={accessibilityLabel}
      onOpen={(rect) => {
        if (context === null || messageKey === null) return;
        context.open({ key: messageKey, side, text, rect, lifted: children, radius, card });
      }}
    >
      {children}
    </ReactableBubble>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
