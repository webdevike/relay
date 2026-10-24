import type { ReactElement, ReactNode } from "react";
import { ScrollView, StyleSheet, View, type RefreshControlProps } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text } from "./Text";
import { spacing, useColors } from "@/theme";

export interface ScreenProps {
  title?: string;
  headerRight?: ReactNode;
  children: ReactNode;
  /** Body scrolls under a fixed header; for screens whose content can outgrow the viewport. */
  scroll?: boolean;
  /** Pull-to-refresh for a scrolling body; ignored unless `scroll`. */
  refreshControl?: ReactElement<RefreshControlProps>;
  /** False holds a scrolling body still, e.g. while something inside it is being dragged. */
  scrollEnabled?: boolean;
}

export function Screen({ title, headerRight, children, scroll = false, refreshControl, scrollEnabled = true }: ScreenProps) {
  const colors = useColors();
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bg }]} edges={["top", "bottom"]}>
      {(title !== undefined || headerRight !== undefined) && (
        <View style={styles.header}>
          {title !== undefined && (
            <Text variant="largeTitle" style={styles.title}>
              {title}
            </Text>
          )}
          {headerRight}
        </View>
      )}
      {scroll ? (
        <ScrollView
          style={styles.body}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          automaticallyAdjustKeyboardInsets
          refreshControl={refreshControl}
          scrollEnabled={scrollEnabled}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={styles.body}>{children}</View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    minHeight: 56,
  },
  title: { flexShrink: 1 },
  body: { flex: 1 },
});
