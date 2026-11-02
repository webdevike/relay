/**
 * The frame of a PR, ticket or Slack screen (Linear's issue view): the page scrolls under a
 * floating glass header (blurred beneath it) and under the dock floating at the bottom (the action
 * bars, or the composer card over the keyboard), with a toast above the dock.
 */
import { createContext, useCallback, useContext, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Dimensions, Keyboard, KeyboardAvoidingView, ScrollView, StyleSheet, View, type RefreshControlProps } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { spacing, useColors } from "@/theme";
import { GLASS_HEIGHT } from "@/ui/Glass";
import { Toast } from "@/ui/Toast";
import { TopBlur } from "@/ui/TopBlur";

/** The header row: a glass control and its vertical padding. */
const HEADER_HEIGHT = GLASS_HEIGHT + 2 * spacing.sm;
/** How close to the end still counts as being at the bottom. */
const END_SLOP = 48;

/** Scrolls the page so a view inside it (a thread's reply box) sits above the dock and the keyboard. */
const RevealContext = createContext<(node: View | null) => void>(() => undefined);

export function useItemReveal(): (node: View | null) => void {
  return useContext(RevealContext);
}

export interface ItemScreenProps {
  header: ReactNode;
  children: ReactNode;
  dock: ReactNode;
  refreshControl?: ReactElement<RefreshControlProps> | undefined;
  toast: string | null;
  /** Opens at the newest content (a Slack thread) and stays there while Isaac is at the bottom. */
  stickToEnd?: boolean;
  /** Changes when Astra's cards grow: followed to the end while Isaac is at the bottom. */
  followKey?: string;
  /** Changes when Isaac asks Astra: the page scrolls to his ask wherever he was. */
  revealKey?: number;
}

export function ItemScreen({ header, children, dock, refreshControl, toast, stickToEnd = false, followKey = "", revealKey = 0 }: ItemScreenProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const scroll = useRef<ScrollView>(null);
  const [dockHeight, setDockHeight] = useState(0);
  const metrics = useRef({ offset: 0, viewport: 0, content: 0 });
  const followed = useRef(followKey);
  const revealed = useRef(revealKey);
  const top = insets.top + HEADER_HEIGHT;

  const onContentSize = (height: number) => {
    const m = metrics.current;
    // Measured against the old height: was Isaac at the end before this content came in?
    const atEnd = m.offset + m.viewport >= m.content - END_SLOP;
    m.content = height;
    const follow = followed.current !== followKey;
    followed.current = followKey;
    const reveal = revealed.current !== revealKey;
    revealed.current = revealKey;
    if (reveal || (atEnd && (follow || stickToEnd))) scroll.current?.scrollToEnd({ animated: !stickToEnd || reveal });
  };

  const revealNode = useCallback(
    (node: View | null) => {
      node?.measureInWindow((_x, y, _width, height) => {
        const visibleBottom = (Keyboard.metrics()?.screenY ?? Dimensions.get("window").height) - dockHeight - spacing.md;
        const over = y + height - visibleBottom;
        if (over > 0) scroll.current?.scrollTo({ y: metrics.current.offset + over, animated: true });
      });
    },
    [dockHeight],
  );

  // The agent screen's layout: the avoiding view is the safe area's direct child, so the frame it
  // measures is its place on screen. Nested under `Screen`'s body it measured from below the status
  // bar and left the composer that much behind the keyboard.
  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: colors.bg }]} edges={["bottom"]}>
      <KeyboardAvoidingView style={styles.fill} behavior="padding">
        {/* The dock floats over the page inside this plain box, which the avoiding view shrinks above the keyboard. */}
        <View style={styles.fill}>
          <ScrollView
            ref={scroll}
            style={styles.fill}
            contentContainerStyle={{ paddingTop: top, paddingBottom: dockHeight + spacing.xl }}
            scrollIndicatorInsets={{ top: top - insets.top, bottom: dockHeight }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            refreshControl={refreshControl}
            scrollEventThrottle={64}
            onScroll={(event) => {
              const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
              metrics.current = { offset: contentOffset.y, viewport: layoutMeasurement.height, content: contentSize.height };
            }}
            onLayout={(event) => {
              metrics.current.viewport = event.nativeEvent.layout.height;
            }}
            onContentSizeChange={(_, height) => {
              onContentSize(height);
            }}
          >
            <RevealContext.Provider value={revealNode}>{children}</RevealContext.Provider>
          </ScrollView>
          {/* Text scrolling under the bottom controls blurs out instead of reading between them (Linear's bottom edge). */}
          {dockHeight > 0 && <TopBlur edge="bottom" height={dockHeight + spacing.xl} strength={2} />}
          <View
            style={styles.dock}
            onLayout={(event) => {
              setDockHeight(event.nativeEvent.layout.height);
            }}
          >
            {dock}
          </View>
        </View>
      </KeyboardAvoidingView>
      <TopBlur height={top + spacing.md} />
      <View style={[styles.header, { paddingTop: insets.top }]}>{header}</View>
      {toast !== null && (
        <View style={[styles.toast, { bottom: dockHeight + insets.bottom + spacing.lg }]} pointerEvents="none">
          <Toast message={toast} />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  dock: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: spacing.md, paddingBottom: spacing.sm, gap: spacing.sm },
  header: { position: "absolute", top: 0, left: 0, right: 0 },
  toast: { position: "absolute", left: 0, right: 0, alignItems: "center" },
});
