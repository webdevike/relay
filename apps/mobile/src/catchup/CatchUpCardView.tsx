/**
 * One Catch Up card's face: where it came from (glyph + label), the title, why it needs Isaac (the
 * feed's `why`, when it has one), why an assistant handed it back (if one did), the markdown body
 * (scrolls inside the card when long), and a footer with how long ago, the note button and an Open link.
 *
 * Swiping up starts from the parts that do not scroll: the header and footer always, the body only
 * when it is short enough not to scroll, so reading a long card never sends it away.
 */
import { memo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { SymbolView } from "expo-symbols";
import type { CatchUpCard } from "@relay/protocol";
import { MessageText } from "@/agents/MessageText";
import { Callout } from "@/ui/Callout";
import { IconButton } from "@/ui/IconButton";
import { LinkButton } from "@/ui/LinkButton";
import { SwipeCardScrollView, SwipeUpHandle } from "@/ui/SwipeCard";
import { Text } from "@/ui/Text";
import { relativeTime } from "@/lib/format";
import { SOURCE_SYMBOL } from "@/lib/catchup";
import { agentTitle, useAssistantStore } from "@/state/assistant";
import { spacing, useColors, useScheme } from "@/theme";

export const CATCHUP_CARD_RADIUS = 28;

export interface CatchUpCardViewProps {
  card: CatchUpCard;
  /** Opens the note sheet for this card; stable across renders (the face is memoized). */
  onNote: (card: CatchUpCard) => void;
}

/** What the face shows; every host snapshot brings new objects for the same cards. */
function sameFace(a: CatchUpCardViewProps, b: CatchUpCardViewProps): boolean {
  const x = a.card;
  const y = b.card;
  return (
    x.id === y.id &&
    x.source === y.source &&
    x.label === y.label &&
    x.title === y.title &&
    x.why === y.why &&
    x.body === y.body &&
    x.url === y.url &&
    x.ts === y.ts &&
    x.bounce?.at === y.bounce?.at &&
    a.onNote === b.onNote
  );
}

/** Memoized: a deck re-renders on every snapshot, and a long markdown body is expensive to rebuild. */
export const CatchUpCardView = memo(function CatchUpCardView({ card, onNote }: CatchUpCardViewProps) {
  const colors = useColors();
  const dark = useScheme() === "dark";
  const agents = useAssistantStore((state) => state.agents);
  const age = relativeTime(Date.parse(card.ts));
  const [viewport, setViewport] = useState(0);
  const [content, setContent] = useState(0);
  // A body that fits is a plain view (the whole card then starts a swipe up); one that overflows
  // becomes a ScrollView, which keeps its vertical drags. A disabled ScrollView would still hold them.
  const scrolls = viewport > 0 && content > viewport + 1;
  const bouncer = card.bounce === undefined ? null : agentTitle(agents, card.bounce.agent);
  const body = (
    <View
      style={styles.body}
      onLayout={(event) => {
        setContent(event.nativeEvent.layout.height);
      }}
    >
      {card.body !== "" && <MessageText text={card.body} large />}
    </View>
  );
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.surface, borderColor: colors.hairline },
        !dark && styles.lightShadow,
      ]}
    >
      <SwipeUpHandle>
        <View style={styles.header}>
          <View style={styles.source}>
            <SymbolView
              name={SOURCE_SYMBOL[card.source]}
              size={14}
              tintColor={colors.textMuted}
              weight="semibold"
            />
            <Text variant="label" color="textMuted" numberOfLines={1} style={styles.flex}>
              {card.label}
            </Text>
          </View>
          <Text variant="largeTitle" style={styles.title}>
            {card.title}
          </Text>
          {card.why !== undefined && card.why !== "" && (
            <Text variant="label" color="textMuted">
              {card.why}
            </Text>
          )}
          {card.bounce !== undefined && bouncer !== null && (
            <Callout tone="warn" title={`${bouncer} couldn't act`} text={card.bounce.reason} />
          )}
        </View>
      </SwipeUpHandle>
      <SwipeUpHandle enabled={!scrolls} style={styles.flex}>
        <View
          style={styles.viewport}
          onLayout={(event) => {
            setViewport(event.nativeEvent.layout.height);
          }}
        >
          {scrolls ? (
            <SwipeCardScrollView style={styles.flex}>
              {body}
            </SwipeCardScrollView>
          ) : (
            body
          )}
        </View>
      </SwipeUpHandle>
      <SwipeUpHandle>
        <View style={[styles.footer, { borderTopColor: colors.hairline }]}>
          <Text variant="caption" color="textFaint" style={styles.flex}>
            {age === "now" ? "Just now" : `${age} ago`}
          </Text>
          <IconButton
            symbol="square.and.pencil"
            size={32}
            glyphSize={15}
            backgroundColor="transparent"
            tintColor={colors.textMuted}
            accessibilityLabel="Note why this does or doesn't need you"
            onPress={() => {
              onNote(card);
            }}
          />
          {card.url !== undefined && <LinkButton url={card.url} label="Open" />}
        </View>
      </SwipeUpHandle>
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
  header: { gap: spacing.md },
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
  viewport: { flex: 1, overflow: "hidden" },
});
