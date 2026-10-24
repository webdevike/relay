/**
 * Usage widget. Small: the most used window across every account as one ring, its share and whose
 * it is. Medium: the Home profile's accounts (Claude, Codex) side by side, each with its windows as
 * concentric rings and a legend; every account when that profile has none. Opens /usage.
 */
import { StyleSheet, View } from "react-native";
import type { UsageAccount, UsageSnapshot } from "@relay/protocol";
import { Rings } from "@/usage/Rings";
import { VendorLogo } from "@/agents/VendorLogo";
import { Text } from "@/ui/Text";
import {
  percent,
  PROVIDER_LABEL,
  PROVIDER_VENDOR,
  RING_COLORS,
  USAGE_TONE_COLOR,
  usagePeak,
  windowTone,
  type UsagePeak,
} from "@/lib/usage";
import { useUsageStore } from "@/state/usage";
import { useConnectionStore } from "@/state/connection";
import { useSettingsStore } from "@/state/settings";
import { spacing, useColors } from "@/theme";
import { WidgetFigure, WidgetHeader, WidgetNote, WidgetSpacer, WidgetSurface, type WidgetBodyProps } from "../WidgetParts";

const HREF = "/usage";

function ringColor(account: UsageAccount, index: number): string {
  const palette = RING_COLORS[account.provider];
  return palette[index] ?? palette[0] ?? "#FF7A45";
}

/** The figure's colour: plain text while fine, amber nearly spent, red limited. */
function toneColor(peak: UsagePeak): string | undefined {
  const tone = windowTone(peak.window);
  return tone === "accent" ? undefined : USAGE_TONE_COLOR[tone];
}

/** Why there is no ring to draw. */
function emptyNote(usage: UsageSnapshot | null, connected: boolean): string {
  if (usage === null) return connected ? "Loading usage…" : "Not connected";
  return usage.accounts.length === 0 ? "No accounts" : "No usage data";
}

function SmallUsage({ peak }: { peak: UsagePeak }) {
  const index = peak.account.windows.indexOf(peak.window);
  return (
    <>
      <View style={styles.smallRing}>
        <Rings size={58} stroke={8} rings={[{ key: peak.window.id, fraction: peak.window.usedFraction, color: ringColor(peak.account, index) }]} />
        <View style={styles.ringLogo}>
          <VendorLogo vendor={PROVIDER_VENDOR[peak.account.provider]} size={18} />
        </View>
      </View>
      <WidgetSpacer />
      <Text variant="caption" color="textMuted" numberOfLines={1}>
        {PROVIDER_LABEL[peak.account.provider]} · {peak.account.profileLabel}
      </Text>
      <WidgetFigure value={percent(peak.window.usedFraction)} color={toneColor(peak)} small />
      <Text variant="caption" color="textFaint" numberOfLines={1}>
        {peak.window.status !== "ok" ? `Limited · ${peak.window.label}` : peak.window.label}
      </Text>
    </>
  );
}

function AccountColumn({ account, showProfile }: { account: UsageAccount; showProfile: boolean }) {
  const colors = useColors();
  const windows = account.windows.slice(0, RING_COLORS[account.provider].length);
  return (
    <View style={styles.column}>
      <View style={styles.columnHead}>
        <VendorLogo vendor={PROVIDER_VENDOR[account.provider]} size={14} />
        <Text variant="caption" numberOfLines={1} style={[styles.columnTitle, { color: ringColor(account, 0) }]}>
          {PROVIDER_LABEL[account.provider].toUpperCase()}
          {showProfile ? ` · ${account.profileLabel.toUpperCase()}` : ""}
        </Text>
      </View>
      {windows.length === 0 ? (
        <WidgetNote text={account.error ?? "No limits reported"} />
      ) : (
        <View style={styles.columnBody}>
          <Rings
            size={64}
            stroke={7}
            rings={windows.map((w, i) => ({ key: w.id, fraction: w.usedFraction, color: ringColor(account, i) }))}
          />
          <View style={styles.legends}>
            {windows.map((w, i) => {
              const tone = windowTone(w);
              return (
                <View key={w.id} style={styles.legend}>
                  <View style={[styles.dot, { backgroundColor: ringColor(account, i) }]} />
                  <Text variant="caption" color="textMuted" numberOfLines={1} style={styles.flex}>
                    {w.label}
                  </Text>
                  <Text
                    variant="caption"
                    tabular
                    style={[styles.share, { color: tone === "accent" ? colors.text : USAGE_TONE_COLOR[tone] }]}
                  >
                    {percent(w.usedFraction)}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
      )}
    </View>
  );
}

export function UsageWidget({ size, open, a11y }: WidgetBodyProps) {
  const usage = useUsageStore((state) => state.usage);
  const connected = useConnectionStore((state) => state.status === "connected");
  const profile = useSettingsStore((state) => state.ompProfile);
  const peak = usagePeak(usage);
  const all = usage?.accounts ?? [];
  const mine = all.filter((account) => account.profile === profile);
  const shown = (mine.length > 0 ? mine : all).slice(0, 2);
  const label =
    peak === null
      ? `Usage. ${emptyNote(usage, connected)}`
      : size === "small"
        ? `Usage. ${PROVIDER_LABEL[peak.account.provider]} ${peak.account.profileLabel}, ${percent(peak.window.usedFraction)} of ${peak.window.label}`
        : `Usage. ${shown
            .map((a) => `${PROVIDER_LABEL[a.provider]}: ${a.windows.map((w) => `${w.label} ${percent(w.usedFraction)}`).join(", ") || "no limits"}`)
            .join(". ")}`;
  return (
    <WidgetSurface label={label} href={HREF} open={open} a11y={a11y}>
      {peak === null || shown.length === 0 ? (
        <>
          <WidgetHeader symbol="gauge.with.dots.needle.67percent" title="Usage" color="pink" />
          <WidgetSpacer />
          <WidgetNote text={emptyNote(usage, connected)} />
        </>
      ) : size === "small" ? (
        <SmallUsage peak={peak} />
      ) : (
        <View style={styles.columns}>
          {shown.map((account) => (
            <AccountColumn key={account.key} account={account} showProfile={mine.length === 0} />
          ))}
        </View>
      )}
    </WidgetSurface>
  );
}

const styles = StyleSheet.create({
  smallRing: { width: 58, height: 58 },
  ringLogo: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  columns: { flex: 1, flexDirection: "row", gap: spacing.lg },
  column: { flex: 1, gap: spacing.sm, justifyContent: "center" },
  columnHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  columnTitle: { flexShrink: 1, fontWeight: "600", letterSpacing: 0.3 },
  columnBody: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  legends: { flex: 1, gap: 3 },
  legend: { flexDirection: "row", alignItems: "center", gap: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  share: { fontWeight: "600" },
  flex: { flex: 1 },
});
