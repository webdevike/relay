/**
 * The card stack's tab on the composer (Relay ask cards, Isaac 2026-11-24): an inset tab whose
 * bottom tucks behind the composer pill, showing the front card's title. Behind it, one sliver for
 * any further cards. A question's tab ends in a chevron (and an X when it can be dismissed); a
 * running card's in a subtle link (Open session). A tap anywhere else opens the stack.
 *
 * Values from the ask-cards prototype (`collapsed.tsx`, `styles.css` `.dockCard`, `.row`, `.peek`).
 */
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, Keyframe, ReduceMotion } from "react-native-reanimated";
import { SymbolView } from "expo-symbols";
import { useComposerFill } from "./ComposerPill";
import { Text } from "./Text";
import { useColors } from "@/theme";
import { tapHaptic } from "@/lib/haptics";

/** The tab's face, above the pill. */
const FACE = 50;
/** How far the tab runs on under the pill. */
export const TAB_TUCK = 18;
/** Inset of the tab from the pill's sides. */
const INSET = 16;
const RADIUS = 16;
/** Room each way so the X and the link make 44 pt targets. */
const SLOP = { top: 12, bottom: 12, left: 10, right: 10 };

const RISE = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: 16 }] },
  100: { opacity: 1, transform: [{ translateY: 0 }] },
})
  .duration(240)
  .reduceMotion(ReduceMotion.System);
const SINK = new Keyframe({
  0: { opacity: 1, transform: [{ translateY: 0 }] },
  100: { opacity: 0, transform: [{ translateY: 16 }] },
})
  .delay(150)
  .duration(200)
  .reduceMotion(ReduceMotion.System);
const FACE_IN = FadeIn.duration(150).reduceMotion(ReduceMotion.System);
const FACE_OUT = FadeOut.duration(100).reduceMotion(ReduceMotion.System);

export type StackTabAction =
  /** A question: the chevron, and an X when `onDismiss` is given. */
  | { kind: "open"; onDismiss?: (() => void) | undefined; dismissLabel?: string }
  /** A running card: a subtle link instead of the chevron. */
  | { kind: "link"; label: string; onPress: () => void };

export interface StackTabProps {
  /** Keys the face, so a new front card fades in over the old one. */
  faceKey: string;
  title: string;
  /** Cards behind the front one: one sliver shows above the tab for any. */
  behind: number;
  /** The stack is open over the screen: the sliver hides. */
  open: boolean;
  action: StackTabAction;
  onPress: () => void;
  accessibilityLabel: string;
}

export function StackTab({ faceKey, title, behind, open, action, onPress, accessibilityLabel }: StackTabProps) {
  const colors = useColors();
  const fill = useComposerFill();
  const edge = { backgroundColor: fill, borderColor: colors.hairline };
  return (
    <Animated.View entering={RISE} exiting={SINK} style={styles.host}>
      {behind > 0 && !open && <View pointerEvents="none" style={[styles.peek, edge]} />}
      <View style={[styles.tab, edge]}>
        <Animated.View key={faceKey} entering={FACE_IN} exiting={FACE_OUT} style={styles.face}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityHint="Opens the cards"
            onPress={() => {
              tapHaptic();
              onPress();
            }}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceRaised }]}
          >
            <Text numberOfLines={1} style={[styles.title, action.kind === "link" && styles.titleBeforeLink]}>
              {title}
            </Text>
            {action.kind === "open" && <SymbolView name="chevron.up" size={14} weight="semibold" tintColor={colors.textMuted} style={styles.chevron} />}
          </Pressable>
          {action.kind === "open" && action.onDismiss !== undefined && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={action.dismissLabel ?? "Dismiss"}
              hitSlop={SLOP}
              onPress={action.onDismiss}
              style={({ pressed }) => [styles.dismiss, pressed && { backgroundColor: colors.surfaceRaised }]}
            >
              <SymbolView name="xmark" size={12} weight="semibold" tintColor={colors.textMuted} />
            </Pressable>
          )}
          {action.kind === "link" && (
            <Pressable accessibilityRole="link" accessibilityLabel={`${action.label}: ${title}`} hitSlop={SLOP} onPress={action.onPress} style={styles.link}>
              {({ pressed }) => (
                <Text variant="caption" color={pressed ? "text" : "textMuted"}>
                  {action.label}
                </Text>
              )}
            </Pressable>
          )}
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: { marginHorizontal: INSET, height: FACE + TAB_TUCK, marginBottom: -TAB_TUCK },
  peek: {
    position: "absolute",
    top: -6,
    left: INSET,
    right: INSET,
    height: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
  },
  tab: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    borderTopLeftRadius: RADIUS,
    borderTopRightRadius: RADIUS,
    overflow: "hidden",
  },
  face: { position: "absolute", top: 0, left: 0, right: 0, height: FACE },
  row: { height: FACE, flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 14, paddingRight: 14 },
  title: { flex: 1, minWidth: 0, fontWeight: "600" },
  /** Clear of the link, which sits over the row's right end. */
  titleBeforeLink: { marginRight: 96 },
  chevron: { width: 16, height: 16, marginLeft: 30 },
  dismiss: { position: "absolute", right: 36, top: 13, width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  link: { position: "absolute", right: 14, top: 0, height: FACE, justifyContent: "center" },
});
