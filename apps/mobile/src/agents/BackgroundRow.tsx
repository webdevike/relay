/**
 * A background message in an assistant thread, drawn quietly in the middle like an iMessage system
 * row instead of as Isaac's bubble (the desktop chat's design, from the same parser):
 * A, an event (a job line, canvas notice, Relay Assist handoff, tapback): one muted line with its
 * icon, source and first sentence, and the time; a tap opens the whole text in place.
 * C, a heartbeat: a row of per-source count pills ("Gmail 2", "Work 1"); a tap opens the items as
 * a divided list, each with its source icon and an Open link when it carries one.
 */
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { SymbolView, type SFSymbol } from "expo-symbols";
import type { BackgroundIcon, BackgroundMessage, HeartbeatItem } from "@/lib/background";
import { relativeTime } from "@/lib/format";
import { tapHaptic } from "@/lib/haptics";
import { openChatLink } from "@/lib/links";
import { radii, spacing, useColors } from "@/theme";
import { Text } from "@/ui/Text";
import { MessageText } from "./MessageText";

const ICONS: Record<BackgroundIcon, SFSymbol> = {
  robot: "cpu",
  board: "square.grid.2x2",
  hand: "hand.point.up.left",
  chat: "bubble.left",
  reaction: "face.smiling",
};

const SOURCE_ICONS: Record<string, SFSymbol> = {
  gmail: "envelope",
  work: "briefcase",
  project: "folder",
  github: "chevron.left.forwardslash.chevron.right",
  slack: "number",
};

/** Widest the row and its opened body get, so a long line stays a quiet strip in the middle. */
const MAX_WIDTH = 420;
const ICON = 12;

export interface BackgroundRowProps {
  message: BackgroundMessage;
  at: number;
  /** The opened body's card fill: the thread's incoming bubble colour. */
  fill: string;
}

export function BackgroundRow({ message, at, fill }: BackgroundRowProps) {
  const [open, setOpen] = useState(false);
  const colors = useColors();
  const heartbeat = message.kind === "heartbeat";
  // `gmail` reads as `Gmail` on its pill; a heartbeat with no item lines gets one pill for its count.
  const pills = !heartbeat
    ? []
    : (message.sources.length === 0 ? [{ source: "heartbeat", count: message.count }] : message.sources).map(
        (s) => `${s.source.charAt(0).toUpperCase()}${s.source.slice(1)} ${String(s.count)}`,
      );
  const label = heartbeat ? `Heartbeat from ${message.from}, ${String(message.count)} new: ${pills.join(", ")}` : message.summary;
  return (
    <View style={styles.row} testID={heartbeat ? "background-heartbeat" : "background-event"}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
        accessibilityHint={open ? "Hides the details" : "Shows the details"}
        hitSlop={6}
        onPress={() => {
          tapHaptic();
          setOpen(!open);
        }}
        style={({ pressed }) => [styles.head, { opacity: pressed ? 0.6 : 1 }]}
      >
        <SymbolView name={heartbeat ? "waveform.path.ecg" : ICONS[message.icon]} size={ICON} tintColor={colors.textFaint} />
        {heartbeat ? (
          <View style={styles.pills}>
            {pills.map((pill) => (
              <View key={pill} style={[styles.pill, { borderColor: colors.hairline, backgroundColor: colors.surfaceRaised }]}>
                <Text variant="caption" color="textMuted" tabular>
                  {pill}
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <Text variant="caption" color="textMuted" numberOfLines={1} style={styles.summary}>
            {message.summary}
          </Text>
        )}
        <Text variant="caption" color="textFaint" tabular>
          {relativeTime(at)}
        </Text>
        <SymbolView name={open ? "chevron.up" : "chevron.down"} size={9} tintColor={colors.textFaint} />
      </Pressable>
      {open && (
        <Animated.View
          entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
          style={[styles.body, { backgroundColor: fill, borderColor: colors.hairline }]}
          testID={heartbeat ? "background-list" : "background-body"}
        >
          {!heartbeat ? (
            <MessageText text={message.text} />
          ) : message.items.length === 0 ? (
            <Text variant="body" color="textMuted">
              {message.text}
            </Text>
          ) : (
            message.items.map((item, i) => <ItemLine key={i} item={item} first={i === 0} />)
          )}
        </Animated.View>
      )}
    </View>
  );
}

function ItemLine({ item, first }: { item: HeartbeatItem; first: boolean }) {
  const colors = useColors();
  const link = item.link;
  const icon: SFSymbol | undefined = SOURCE_ICONS[item.source.toLowerCase()];
  return (
    <View style={[styles.item, !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline }]}>
      <View style={styles.itemIcon}>
        {/* A source with no glyph of its own gets a small dot. */}
        <SymbolView name={icon ?? "circle.fill"} size={icon === undefined ? 5 : 13} tintColor={colors.textMuted} />
      </View>
      <Text variant="body" numberOfLines={3} style={styles.itemTitle}>
        {item.title}
      </Text>
      {link !== null ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Open ${item.title}`}
          hitSlop={8}
          onPress={() => {
            openChatLink(link);
          }}
        >
          <Text variant="label" color="accent">
            Open
          </Text>
        </Pressable>
      ) : (
        item.meta !== null && (
          <Text variant="caption" color="textFaint" numberOfLines={1} style={styles.meta}>
            {item.meta}
          </Text>
        )
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: spacing.xl, alignItems: "center" },
  head: { flexDirection: "row", alignItems: "center", gap: spacing.sm, maxWidth: MAX_WIDTH, paddingVertical: spacing.xs },
  summary: { flexShrink: 1 },
  pills: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: spacing.xs, flexShrink: 1 },
  pill: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: spacing.sm, paddingVertical: 1 },
  body: {
    alignSelf: "stretch",
    maxWidth: MAX_WIDTH,
    marginTop: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  item: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, paddingVertical: spacing.sm },
  itemIcon: { width: 16, height: 20, alignItems: "center", justifyContent: "center" },
  itemTitle: { flex: 1 },
  meta: { maxWidth: 120, paddingTop: 2 },
});
