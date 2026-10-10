/**
 * The ```ui "pr" widget, GitHub-mobile style: repo, number, state and title up top, branch and
 * author under it, then three tabs. Overview renders the description as full markdown (code blocks,
 * lists, links) plus reviewers; Checks lists the Actions runs; Files shows one Zed-style diff per
 * file. Composes MessageText, DiffView, Pill, Row, LinkButton and SegmentedTabs.
 */
import { useState } from "react";
import { View } from "react-native";
import { spacing, useColors } from "@/theme";
import { LinkButton } from "@/ui/LinkButton";
import { Pill, type PillProps } from "@/ui/Pill";
import { SegmentedTabs } from "@/ui/SegmentedTabs";
import { Text } from "@/ui/Text";
import { DiffView } from "./DiffView";
import { MessageText } from "./MessageText";
import type { PrSpec } from "./widget";

type Tab = "overview" | "checks" | "files";
type PillTone = NonNullable<PillProps["tone"]>;

const STATE_TONE: Record<PrSpec["state"], PillTone> = { open: "ok", draft: "textMuted", merged: "accent", closed: "danger" };
const CHECK_TONE: Record<string, PillTone> = { success: "ok", failure: "danger", pending: "warn", skipped: "textMuted" };
const REVIEW_LABEL: Record<string, [string, PillTone]> = {
  approved: ["Approved", "ok"],
  changes: ["Changes requested", "danger"],
  commented: ["Commented", "textMuted"],
  pending: ["Pending", "warn"],
};

export function PrCard({ spec }: { spec: PrSpec }) {
  const colors = useColors();
  const [tab, setTab] = useState<Tab>("overview");
  const checks = spec.checks ?? [];
  const files = spec.files ?? [];
  const failed = checks.filter((c) => c.status === "failure").length;
  const passed = checks.filter((c) => c.status === "success").length;

  return (
    <View style={{ gap: spacing.md }}>
      <View style={{ gap: spacing.xs }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <Text variant="caption" color="textMuted" style={{ flex: 1 }} numberOfLines={1}>
            {spec.repo} #{spec.number}
          </Text>
          <Pill label={spec.state} tone={STATE_TONE[spec.state]} />
          {spec.url !== undefined && <LinkButton url={spec.url} variant="icon" />}
        </View>
        <Text variant="title">{spec.title}</Text>
        {(spec.branch !== undefined || spec.author !== undefined) && (
          <Text variant="caption" color="textMuted" numberOfLines={2}>
            {[spec.author, spec.branch !== undefined ? `${spec.branch} → ${spec.base ?? "main"}` : undefined].filter(Boolean).join(" · ")}
          </Text>
        )}
      </View>

      <SegmentedTabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "overview", label: "Overview" },
          { key: "checks", label: checks.length === 0 ? "Checks" : failed > 0 ? `Checks · ${failed} failed` : `Checks · ${passed}/${checks.length}` },
          { key: "files", label: `Files · ${files.length}` },
        ]}
      />

      {tab === "overview" && (
        <View style={{ gap: spacing.md }}>
          {spec.body !== undefined && spec.body.trim() !== "" ? (
            <MessageText text={spec.body} />
          ) : (
            <Text color="textMuted">No description.</Text>
          )}
          {(spec.reviewers ?? []).length > 0 && (
            <View style={{ gap: spacing.xs, borderTopWidth: 1, borderTopColor: colors.hairline, paddingTop: spacing.sm }}>
              <Text variant="label">Reviewers</Text>
              {(spec.reviewers ?? []).map((r) => {
                const [label, tone] = REVIEW_LABEL[r.state] ?? ["Pending", "warn"];
                return (
                  <View key={r.name} style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                    <Text style={{ flex: 1 }} numberOfLines={1}>{r.name}</Text>
                    <Pill label={label} tone={tone} />
                  </View>
                );
              })}
            </View>
          )}
        </View>
      )}

      {tab === "checks" && (
        <View>
          {checks.length === 0 && <Text color="textMuted">No checks reported.</Text>}
          {checks.map((c, i) => (
            <View
              key={`${c.name}-${i}`}
              style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.hairline }}
            >
              <Pill label={c.status} tone={CHECK_TONE[c.status] ?? "warn"} />
              <Text style={{ flex: 1 }} numberOfLines={1}>{c.name}</Text>
              {c.duration !== undefined && <Text variant="caption" color="textMuted" tabular>{c.duration}</Text>}
              {c.url !== undefined && <LinkButton url={c.url} variant="icon" />}
            </View>
          ))}
        </View>
      )}

      {tab === "files" && (
        <View style={{ gap: spacing.sm }}>
          {files.length === 0 && <Text color="textMuted">No file diffs included.</Text>}
          {files.map((f) => (
            <DiffView key={f.file} spec={{ widget: "diff", file: f.file, patch: f.patch }} />
          ))}
        </View>
      )}
    </View>
  );
}
