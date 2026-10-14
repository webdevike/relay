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
}

/**
 * The tool call a session is blocked on, with the command verbatim. A destructive call (force push,
 * `rm -rf`, deploy, prod write) is flagged and its Approve says it needs Face ID; there is no
 * "always allow".
 */
export function ApprovalCard({ approval, busy, error, onApprove, onDeny }: ApprovalCardProps) {
  const colors = useColors();
  const flagged = approval.destructive !== undefined || approval.requiresBiometric;
  return (
    <Card maxHeight={360}>
      <View style={styles.header}>
        <Text variant="title">Needs approval</Text>
        {flagged && <Pill tone="warn" label={approval.destructive === undefined ? "Face ID" : `Face ID · ${approval.destructive}`} />}
      </View>
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
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
    </Card>
  );
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
