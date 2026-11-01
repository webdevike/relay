/** A PR screen's Conversation post card, Files and Checks tabs (the Guide is `PrGuide`). */
import { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { reviewAgo, type ReviewCheck, type ReviewPr } from "@relay/protocol";
import { DiffView } from "@/agents/DiffView";
import { MessageText } from "@/agents/MessageText";
import { nameTint } from "@/lib/format";
import { openExternal } from "@/lib/links";
import { spacing, useColors, type ColorToken } from "@/theme";
import { Avatar } from "@/ui/Avatar";
import { FEED_AVATAR, FeedCard } from "@/ui/FeedCard";
import { Pill } from "@/ui/Pill";
import { Text } from "@/ui/Text";
import { splitDiffFiles, type PrEntry } from "./model";

/** `+802 −113`, green and red. */
export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <Text variant="label" tabular accessibilityLabel={`${String(additions)} added, ${String(deletions)} removed`}>
      {additions > 0 && <Text variant="label" color="ok">{`+${String(additions)}`}</Text>}
      {additions > 0 && deletions > 0 && " "}
      {deletions > 0 && <Text variant="label" color="danger">{`−${String(deletions)}`}</Text>}
    </Text>
  );
}

const VERDICT: Record<string, { label: string; tone: "ok" | "danger" | "textMuted" }> = {
  APPROVED: { label: "Approved", tone: "ok" },
  CHANGES_REQUESTED: { label: "Changes requested", tone: "danger" },
  DISMISSED: { label: "Dismissed", tone: "textMuted" },
};

/** A Conversation post as a timeline card: the description, a comment, or a review with words and its verdict. */
export function PrPostCard({ post, at, now }: { post: Extract<PrEntry, { kind: "post" }>; at: number; now: number }) {
  const badge = post.verdict === null ? undefined : VERDICT[post.verdict];
  return (
    <FeedCard
      avatar={<Avatar name={post.author} size={FEED_AVATAR} tint={nameTint(post.author)} />}
      name={post.author}
      meta={`· ${reviewAgo(at, now)}`}
      badge={badge === undefined ? undefined : <Pill label={badge.label} tone={badge.tone} />}
    >
      {post.body.trim() !== "" && <MessageText text={post.body} large />}
    </FeedCard>
  );
}

export function PrFiles({ pr }: { pr: ReviewPr }) {
  const patches = useMemo(() => splitDiffFiles(pr.diff), [pr.diff]);
  return (
    <View style={styles.tab}>
      {pr.diffTruncated && (
        <Text variant="caption" color="textFaint">
          The diff is too long to show whole; later files may be missing.
        </Text>
      )}
      {pr.files.map((file) => {
        const patch = patches.get(file.path);
        return (
          <View key={file.path} style={styles.file}>
            <View style={styles.fileHead}>
              <Text variant="caption" color="textMuted" style={styles.change}>
                {file.change.toLowerCase()}
              </Text>
              <DiffStat additions={file.additions} deletions={file.deletions} />
            </View>
            {patch === undefined || patch === "" ? (
              <Text variant="caption" color="textFaint">{`${file.path}: no diff to show`}</Text>
            ) : (
              <DiffView spec={{ widget: "diff", file: file.path, patch }} />
            )}
          </View>
        );
      })}
    </View>
  );
}

const CHECK: Record<ReviewCheck["state"], { symbol: SFSymbol; color: ColorToken; label: string }> = {
  pass: { symbol: "checkmark.circle.fill", color: "ok", label: "passed" },
  fail: { symbol: "xmark.circle.fill", color: "danger", label: "failed" },
  pending: { symbol: "clock", color: "warn", label: "pending" },
  skipped: { symbol: "minus.circle", color: "textFaint", label: "skipped" },
};

export function PrChecks({ pr }: { pr: ReviewPr }) {
  const colors = useColors();
  if (pr.checks.length === 0) {
    return (
      <Text color="textMuted" style={styles.tab}>
        No checks on this PR.
      </Text>
    );
  }
  return (
    <View style={styles.tab}>
      {pr.checks.map((check, i) => {
        const look = CHECK[check.state];
        const url = check.url;
        return (
          <Pressable
            key={`${check.name}-${String(i)}`}
            disabled={url === null}
            accessibilityRole={url === null ? undefined : "link"}
            accessibilityLabel={`${check.name}, ${look.label}`}
            onPress={() => {
              if (url !== null) openExternal(url);
            }}
            style={({ pressed }) => [styles.check, { borderBottomColor: colors.hairline }, pressed && { opacity: 0.6 }]}
          >
            <SymbolView name={look.symbol} size={18} tintColor={colors[look.color]} />
            <Text numberOfLines={1} style={styles.checkName}>
              {check.name}
            </Text>
            {url !== null && <SymbolView name="arrow.up.right" size={12} tintColor={colors.textFaint} />}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  tab: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, gap: spacing.md },
  file: { gap: spacing.xs },
  fileHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  change: { textTransform: "capitalize" },
  check: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  checkName: { flex: 1 },
});
