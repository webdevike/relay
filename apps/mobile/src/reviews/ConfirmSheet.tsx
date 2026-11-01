/**
 * The only way anything leaves for GitHub, Linear or Slack: the sheet shows where it goes and the
 * exact text, and only its confirm button sends.
 */
import { StyleSheet, View } from "react-native";
import { radii, spacing, useColors } from "@/theme";
import { Button } from "@/ui/Button";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";

export interface ConfirmPost {
  /** "Post to GitHub eCardSystems/api#170". */
  destination: string;
  text: string;
  /** The confirm button: Post, Send, Approve, Request changes. */
  action: string;
}

export interface ConfirmSheetProps {
  post: ConfirmPost | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmSheet({ post, busy, error, onCancel, onConfirm }: ConfirmSheetProps) {
  const colors = useColors();
  return (
    <Sheet visible={post !== null} onClose={onCancel}>
      {post !== null && (
        <View style={styles.body}>
          <Text variant="title">{post.destination}</Text>
          <View style={[styles.quote, { backgroundColor: colors.surfaceRaised }]}>
            <Text selectable color={post.text === "" ? "textFaint" : "text"}>
              {post.text === "" ? "No comment" : post.text}
            </Text>
          </View>
          {error !== null && (
            <Text variant="caption" color="danger">
              {error}
            </Text>
          )}
          <View style={styles.buttons}>
            <View style={styles.button}>
              <Button label="Cancel" variant="secondary" height={44} testID="confirm-cancel" onPress={onCancel} />
            </View>
            <View style={styles.button}>
              <Button label={post.action} height={44} loading={busy} testID="confirm-post" accessibilityLabel={post.action} onPress={onConfirm} />
            </View>
          </View>
        </View>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.md, paddingTop: spacing.sm },
  quote: { borderRadius: radii.md, padding: spacing.md },
  buttons: { flexDirection: "row", gap: spacing.md, marginTop: spacing.sm },
  button: { flex: 1 },
});
