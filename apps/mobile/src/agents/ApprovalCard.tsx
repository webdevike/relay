import { Platform, ScrollView, StyleSheet, View } from "react-native";
import type { AgentApproval } from "@relay/protocol";
import { Text } from "@/ui/Text";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { Pill } from "@/ui/Pill";
import { radii, spacing, useColors } from "@/theme";

const mono = Platform.select({ ios: "Menlo", default: "monospace" });

export interface ApprovalCardProps {
  approval: AgentApproval;
  busy: boolean;
  /** Why the last answer did not go through (Face ID declined, Mac unreachable). */
  error: string | null;
  onApprove: () => void;
  onDeny: () => void;
  /**
   * Drawn inside a card of the thread's card stack (`agents/CardStack`), which frames and titles it:
   * no card or title of its own (the Face ID flag stays), at most `maxHeight` tall.
   */
  embedded?: { maxHeight: number };
}

/**
 * The tool call a session is blocked on, with the command verbatim. A destructive call (force push,
 * `rm -rf`, deploy, prod write) is flagged and its Approve says it needs Face ID; there is no
 * "always allow".
 */
export function ApprovalCard({ approval, busy, error, onApprove, onDeny, embedded }: ApprovalCardProps) {
  const colors = useColors();
  const flagged = approval.destructive !== undefined || approval.requiresBiometric;
  const flag = flagged && <Pill tone="warn" label={approval.destructive === undefined ? "Face ID" : `Face ID · ${approval.destructive}`} />;
  const content = (
    <>
      {embedded === undefined ? (
        <View style={styles.header}>
          <Text variant="title">Needs approval</Text>
          {flag}
        </View>
      ) : (
        flagged && <View style={styles.flag}>{flag}</View>
      )}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {approval.reason !== undefined && <Text color="textMuted">{approval.reason}</Text>}
        <View style={[styles.command, { backgroundColor: colors.bg, borderColor: colors.hairline }]}>
          <Text variant="caption" color="textFaint">
            {approval.toolName}
          </Text>
          <Text selectable style={{ fontFamily: mono, fontSize: 13, lineHeight: 18 }}>
            {approval.command}
          </Text>
        </View>
        {error !== null && (
          <Text variant="caption" color="danger">
            {error}
          </Text>
        )}
      </ScrollView>
      <View style={[styles.footer, { borderTopColor: colors.hairline }]}>
        <Button label="Deny" variant="danger" disabled={busy} onPress={onDeny} />
        <Button label={approval.requiresBiometric ? "Approve with Face ID" : "Approve"} loading={busy} onPress={onApprove} />
      </View>
    </>
  );
  return embedded === undefined ? <Card maxHeight={360}>{content}</Card> : <View style={{ maxHeight: embedded.maxHeight }}>{content}</View>;
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  /** In the card stack: the Face ID flag alone, left, over the reason. */
  flag: { flexDirection: "row", paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  /** Takes the room the footer leaves in a height-capped card, so Deny and Approve stay on screen. */
  scroll: { flexGrow: 0, flexShrink: 1 },
  body: {
    gap: spacing.md,
    padding: spacing.lg,
  },
  command: {
    gap: spacing.xs,
    borderRadius: radii.md,
    borderWidth: 1,
    padding: spacing.md,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.md,
    borderTopWidth: 1,
    padding: spacing.md,
  },
});
