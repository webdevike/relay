/**
 * One Catch Up card's face: where it came from (glyph + label), the title, the markdown body
 * (scrolls inside the card when long), and a footer with how long ago and an Open link.
 */
import { memo } from "react";
import { StyleSheet, View } from "react-native";
import { ScrollView } from "react-native-gesture-handler";
import { SymbolView } from "expo-symbols";
import type { CatchUpCard } from "@relay/protocol";
import { MessageText } from "@/agents/MessageText";
import { LinkButton } from "@/ui/LinkButton";
import { Text } from "@/ui/Text";
import { relativeTime } from "@/lib/format";
import { SOURCE_SYMBOL } from "@/lib/catchup";
import { spacing, useColors, useScheme } from "@/theme";

export const CATCHUP_CARD_RADIUS = 28;

/** What the face shows; every host snapshot brings new objects for the same cards. */
function sameFace(a: { card: CatchUpCard }, b: { card: CatchUpCard }): boolean {
  const x = a.card;
  const y = b.card;
  return x.id === y.id && x.source === y.source && x.label === y.label && x.title === y.title && x.body === y.body && x.url === y.url && x.ts === y.ts;
}

/** Memoized: a deck re-renders on every snapshot, and a long markdown body is expensive to rebuild. */
export const CatchUpCardView = memo(function CatchUpCardView({ card }: { card: CatchUpCard }) {
  const colors = useColors();
  const dark = useScheme() === "dark";
  const age = relativeTime(Date.parse(card.ts));
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.surface, borderColor: colors.hairline },
        !dark && styles.lightShadow,
      ]}
    >
      <View style={styles.source}>
        <SymbolView name={SOURCE_SYMBOL[card.source]} size={14} tintColor={colors.textMuted} weight="semibold" />
        <Text variant="label" color="textMuted" numberOfLines={1} style={styles.flex}>
          {card.label}
        </Text>
      </View>
      <Text variant="largeTitle" style={styles.title}>
        {card.title}
      </Text>
      <ScrollView style={styles.flex} contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {card.body !== "" && <MessageText text={card.body} large />}
      </ScrollView>
      <View style={[styles.footer, { borderTopColor: colors.hairline }]}>
        <Text variant="caption" color="textFaint" style={styles.flex}>
          {age === "now" ? "Just now" : `${age} ago`}
        </Text>
        {card.url !== undefined && <LinkButton url={card.url} label="Open" />}
      </View>
    </View>
  );
}, sameFace);

const styles = StyleSheet.create({
  card: {
    flex: 1,
    borderRadius: CATCHUP_CARD_RADIUS,
    borderCurve: "continuous",
    borderWidth: 1,
    padding: spacing.xxl,
    gap: spacing.md,
  },
  lightShadow: {
    shadowColor: "#000000",
    shadowOpacity: 0.1,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
  },
  source: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  title: { fontSize: 24, lineHeight: 30, fontWeight: "700" },
  body: { paddingBottom: spacing.md },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  flex: { flex: 1 },
});
