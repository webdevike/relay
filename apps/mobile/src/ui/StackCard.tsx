/**
 * One card of the card stack, as it stands in the open carousel (`ui/CardCarousel`): a floating
 * panel in the composer's fill with a head row (the kind's glyph and the card's title, and an X for
 * a card Isaac may dismiss) over its body. Values from the ask-cards prototype (`.mItem`, `.mKind`,
 * `.askBody`). The head carries the carousel's VoiceOver actions (next, previous, close).
 */
import type { ReactNode } from "react";
import { StyleSheet, View, type AccessibilityActionEvent } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { useComposerFill } from "./ComposerPill";
import { IconButton } from "./IconButton";
import { Text } from "./Text";
import { useColors } from "@/theme";

const RADIUS = 16;
/** The X is small but takes a 44 pt target. */
const X_SIZE = 28;
const X_SLOP = { top: 8, bottom: 8, left: 8, right: 8 };

export interface StackCardProps {
  symbol: SFSymbol;
  /** The glyph's colour; muted by default. */
  symbolTint?: string | undefined;
  title: string;
  /** Shows the X; absent on cards that cannot be dismissed. */
  onDismiss?: (() => void) | undefined;
  /** VoiceOver name of the X. */
  dismissLabel?: string;
  /** Taller content is cut; the kinds that can run long scroll inside their own body. */
  maxHeight: number;
  /** VoiceOver custom actions on the head (`next`, `previous`, `close`), routed to `onAction`. */
  actions?: readonly { name: string; label: string }[];
  onAction?: (name: string) => void;
  children: ReactNode;
}

export function StackCard({ symbol, symbolTint, title, onDismiss, dismissLabel, maxHeight, actions, onAction, children }: StackCardProps) {
  const colors = useColors();
  const fill = useComposerFill();
  return (
    <View style={[styles.shadow, { maxHeight }]}>
      <View style={[styles.card, { backgroundColor: fill, borderColor: colors.hairline, maxHeight }]}>
        <View style={styles.head}>
          <View
            accessible
            accessibilityRole="header"
            accessibilityLabel={title}
            accessibilityActions={actions}
            onAccessibilityAction={(event: AccessibilityActionEvent) => {
              onAction?.(event.nativeEvent.actionName);
            }}
            style={styles.heading}
          >
            <SymbolView name={symbol} size={15} tintColor={symbolTint ?? colors.textMuted} />
            <Text variant="label" color="textMuted" numberOfLines={1} style={styles.title}>
              {title}
            </Text>
          </View>
          {onDismiss !== undefined && (
            <IconButton
              symbol="xmark"
              size={X_SIZE}
              glyphSize={14}
              backgroundColor="transparent"
              tintColor={colors.text}
              hitSlop={X_SLOP}
              accessibilityLabel={dismissLabel ?? "Dismiss"}
              onPress={onDismiss}
            />
          )}
        </View>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shadow: { borderRadius: RADIUS, shadowColor: "#000000", shadowOpacity: 0.28, shadowRadius: 20, shadowOffset: { width: 0, height: 12 } },
  card: { borderRadius: RADIUS, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden", paddingTop: 10 },
  head: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 16, paddingRight: 10, minHeight: X_SIZE },
  heading: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 },
  title: { flex: 1, minWidth: 0, fontWeight: "600" },
});
