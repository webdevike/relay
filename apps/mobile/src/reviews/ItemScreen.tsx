/** The frame of a PR, ticket or Slack screen: header, scrolling body, the composer dock over the keyboard, a toast. */
import { useRef, type ReactElement, type ReactNode } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, View, type RefreshControlProps } from "react-native";
import { spacing } from "@/theme";
import { Screen } from "@/ui/Screen";
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
  const scroll = useRef<ScrollView>(null);
  return (
    <Screen>
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
        {dock}
      </KeyboardAvoidingView>
      {toast !== null && (
        <View style={styles.toast} pointerEvents="none">
          <Toast message={toast} />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingBottom: spacing.xxl },
  toast: { position: "absolute", left: 0, right: 0, bottom: 120, alignItems: "center" },
});
