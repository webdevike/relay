/** The frame of a PR, ticket or Slack screen: header, scrolling body, the composer dock over the keyboard, a toast. */
import { useRef, type ReactElement, type ReactNode } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, View, type RefreshControlProps } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { spacing, useColors } from "@/theme";
import { Toast } from "@/ui/Toast";

export interface ItemScreenProps {
  header: ReactNode;
  children: ReactNode;
  dock: ReactNode;
  refreshControl?: ReactElement<RefreshControlProps> | undefined;
  toast: string | null;
  /** Keep the newest content in view (a Slack thread). */
  stickToEnd?: boolean;
}

export function ItemScreen({ header, children, dock, refreshControl, toast, stickToEnd = false }: ItemScreenProps) {
  const colors = useColors();
  const scroll = useRef<ScrollView>(null);
  // The agent screen's layout: the avoiding view is the safe area's direct child, so the frame it
  // measures is its place on screen. Nested under `Screen`'s body it measured from below the status
  // bar and left the composer that much behind the keyboard.
  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: colors.bg }]} edges={["top", "bottom"]}>
      <KeyboardAvoidingView style={styles.fill} behavior="padding">
        {header}
        <ScrollView
          ref={scroll}
          style={styles.fill}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          refreshControl={refreshControl}
          onContentSizeChange={() => {
            if (stickToEnd) scroll.current?.scrollToEnd({ animated: false });
          }}
        >
          {children}
        </ScrollView>
        {/* Gives up height before the composer does: with the keyboard up the Astra panel shrinks to what is left. */}
        <View style={styles.dock}>{dock}</View>
      </KeyboardAvoidingView>
      {toast !== null && (
        <View style={styles.toast} pointerEvents="none">
          <Toast message={toast} />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingBottom: spacing.xxl },
  dock: { flexShrink: 1, minHeight: 0 },
  toast: { position: "absolute", left: 0, right: 0, bottom: 120, alignItems: "center" },
});
