/**
 * The one-row status card of a chat (Relay desktop's StatusCard): a lead, one line, the buttons
 * that act on its subject, a quiet end (time, state) and, on a finished card, an X. Canvas Join and
 * wrap-up, sign-in, room ready, guest work and meeting cards all draw through it, so every one can
 * be cleared the same ways: swipe it left, tap the X, or hold it for a menu (Dismiss, Open).
 *
 * Dismissing hides the card at once and offers Undo for a few seconds (`cardUndo`); what is
 * dismissed is kept by id (`state/dismissedCards`, shared with the host and Relay desktop). A card
 * that still `running` can be hidden too, and returns when it stops running. The row's own tap
 * opens it (`onOpen`) or, with `details`, folds them open under the row; the buttons in `actions`
 * never toggle it.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ActionSheetIOS, Pressable, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { SymbolView } from "expo-symbols";
import { impactHaptic, tapHaptic } from "@/lib/haptics";
import { isCardHidden } from "@/lib/dismissedCards";
import { useDismissedCardsStore } from "@/state/dismissedCards";
import { radii, spacing, useColors, type ColorToken } from "@/theme";
import { Text } from "@/ui/Text";
import { dismissCard } from "./cardUndo";
import { dragOffset, shouldDismissSwipe } from "./swipeDismiss";

/** Row height, and the side of the X's touch target: both a full 44pt. */
export const STATUS_ROW_HEIGHT = 44;
/** Holding still this long (ms) opens the menu. */
const HOLD_MS = 450;
/** How long the card takes to leave the screen after a swipe (ms). */
const FLY_MS = 160;

export interface StatusCardRowProps {
  /** Stable name of the card (`canvas:<message id>`): what stays dismissed. */
  id: string;
  /** The work behind the card is not done: no X, and a dismissal lapses when it is. */
  running: boolean;
  /** The card's one line: its text, its VoiceOver label and what the Undo toast quotes. */
  line: string;
  lineColor?: ColorToken;
  /** Lines the text may take before it is cut (one, as on desktop). */
  lineLines?: number;
  /** Face, icon or avatar in front of the line. */
  lead?: ReactNode;
  /** Buttons that act on the card's subject (Join, Open board). They never toggle or dismiss it. */
  actions?: ReactNode;
  /** The quiet end of the row: time, check, state. */
  meta?: ReactNode;
  /** What the card says in full; a tap on the row opens and closes it. */
  details?: ReactNode;
  /** What a tap on the row does on a card with no details (open the chat, the meeting, the room). */
  onOpen?: () => void;
  /** VoiceOver label of the row; `line` when left out. */
  accessibilityLabel?: string;
  /** Border color while something is going on (the work's color); the hairline otherwise. */
  borderColor?: string;
  /** The row's own tint, over the raised surface. */
  fill?: string;
  testID?: string;
  /** The card's own layout in its parent (margins). */
  style?: StyleProp<ViewStyle>;
}

export function StatusCardRow({
  id,
  running,
  line,
  lineColor = "text",
  lineLines = 1,
  lead,
  actions,
  meta,
  details,
  onOpen,
  accessibilityLabel,
  borderColor,
  fill,
  testID,
  style,
}: StatusCardRowProps) {
  const colors = useColors();
  const hidden = useDismissedCardsStore((state) => isCardHidden(state.ids, id, running));
  const [expanded, setExpanded] = useState(false);
  const x = useSharedValue(0);
  const width = useSharedValue(0);

  const dismiss = useCallback(() => {
    impactHaptic("medium");
    dismissCard(id, running, line);
  }, [id, running, line]);
  const open =
    onOpen ??
    (details === undefined
      ? undefined
      : () => {
          setExpanded((was) => !was);
        });
  const openRow = useCallback(() => {
    tapHaptic();
    open?.();
  }, [open]);
  const showMenu = useCallback(() => {
    impactHaptic("medium");
    const items = [{ title: "Dismiss", run: dismiss }, ...(open === undefined ? [] : [{ title: "Open", run: open }])];
    ActionSheetIOS.showActionSheetWithOptions(
      { title: line, options: [...items.map((item) => item.title), "Cancel"], cancelButtonIndex: items.length },
      (index) => {
        items[index]?.run();
      },
    );
  }, [dismiss, open, line]);

  // A card brought back (Undo, another device) must not stay slid away.
  useEffect(() => {
    if (hidden) x.value = 0;
  }, [hidden, x]);

  const gesture = useMemo(() => {
    const swipe = Gesture.Pan()
      .maxPointers(1)
      .activeOffsetX([-12, 12])
      .failOffsetY([-12, 12])
      .onUpdate((event) => {
        x.value = dragOffset(event.translationX);
      })
      .onEnd((event) => {
        if (shouldDismissSwipe(event.translationX, event.velocityX, width.value)) {
          x.value = withTiming(-width.value, { duration: FLY_MS }, (finished) => {
            if (finished) scheduleOnRN(dismiss);
          });
        } else {
          x.value = withSpring(0, { damping: 20, stiffness: 240 });
        }
      });
    const hold = Gesture.LongPress().minDuration(HOLD_MS).runOnJS(true).onStart(showMenu);
    return Gesture.Race(swipe, hold);
  }, [x, width, dismiss, showMenu]);

  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const onLayout = (event: LayoutChangeEvent): void => {
    width.value = event.nativeEvent.layout.width;
  };

  if (hidden) return null;
  const label = accessibilityLabel ?? line;
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        onLayout={onLayout}
        testID={testID}
        accessibilityActions={[{ name: "dismiss", label: "Dismiss" }]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "dismiss") dismiss();
        }}
        style={[styles.card, { backgroundColor: fill ?? colors.surfaceRaised, borderColor: borderColor ?? colors.hairline }, style, slide]}
      >
        <View style={styles.row}>
          {open === undefined ? (
            <View style={styles.main}>
              {lead}
              <Text variant="body" color={lineColor} numberOfLines={lineLines} style={styles.line}>
                {line}
              </Text>
            </View>
          ) : (
            <Pressable
              accessibilityRole={onOpen === undefined ? "button" : "link"}
              accessibilityLabel={label}
              accessibilityState={onOpen === undefined ? { expanded } : {}}
              onPress={openRow}
              style={({ pressed }) => [styles.main, pressed && styles.pressed]}
            >
              {lead}
              <Text variant="body" color={lineColor} numberOfLines={lineLines} style={styles.line}>
                {line}
              </Text>
            </Pressable>
          )}
          {actions}
          {meta}
          {running ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
              testID="status-card-dismiss"
              onPress={dismiss}
              style={({ pressed }) => [styles.x, pressed && styles.pressed]}
            >
              <SymbolView name="xmark" size={13} weight="semibold" tintColor={colors.textMuted} />
            </Pressable>
          )}
        </View>
        {expanded && details !== undefined ? <View style={styles.details}>{details}</View> : null}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: "stretch",
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: STATUS_ROW_HEIGHT,
    paddingHorizontal: spacing.sm,
  },
  main: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: STATUS_ROW_HEIGHT },
  line: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.7 },
  x: { width: STATUS_ROW_HEIGHT, height: STATUS_ROW_HEIGHT, alignItems: "center", justifyContent: "center", marginLeft: -spacing.xs },
  details: { paddingHorizontal: spacing.sm, paddingBottom: spacing.sm, paddingTop: spacing.xs, gap: spacing.xs },
});
