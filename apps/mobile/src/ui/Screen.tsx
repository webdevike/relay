import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text } from "./Text";
import { colors, spacing } from "@/theme";

export interface ScreenProps {
  title?: string;
  headerRight?: ReactNode;
  children: ReactNode;
  scrollPadding?: boolean;
}

export function Screen({ title, headerRight, children }: ScreenProps) {
  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
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
      <View style={styles.body}>{children}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
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
