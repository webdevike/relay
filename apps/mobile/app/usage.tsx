/**
 * Usage (`/usage`): plan limits of every omp account on the host on one page, drawn like iOS
 * Settings: a grouped section per profile (Work, Personal), a block per provider (Claude, Codex)
 * with its email, then each limit window with a bar, its share and when it resets. The host owns
 * the numbers (`useUsageStore().usage`): the screen asks on focus (the host refetches when its copy
 * is over a minute old) and pull-to-refresh forces a refetch.
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { useFocusEffect } from "expo-router";
import type { UsageAccount, UsageWindow } from "@relay/protocol";
import { EmptyState } from "@/ui/EmptyState";
import { VendorLogo } from "@/agents/VendorLogo";
import { Rings } from "@/usage/Rings";
import { Screen } from "@/ui/Screen";
import { Text } from "@/ui/Text";
import { SegmentedTabs } from "@/ui/SegmentedTabs";
import { PROFILE_TABS } from "@/lib/profile";
import { tapHaptic } from "@/lib/haptics";
import { useSettingsStore } from "@/state/settings";
import { refreshUsage, requestUsage } from "@/connection";
import { relativeTime } from "@/lib/format";
import {
  groupByProfile,
  percent,
  PROVIDER_LABEL,
  PROVIDER_VENDOR,
  resetCaption,
  RING_COLORS,
  USAGE_TONE_COLOR,
  windowTone,
} from "@/lib/usage";
import { useConnectionStore } from "@/state/connection";
import { useUsageStore } from "@/state/usage";
import { spacing, useColors } from "@/theme";

/** Reset countdowns move by the minute; a half-minute tick keeps them honest on a screen left open. */
const TICK_MS = 30_000;

const RING_SIZE = 118;

function WindowLegend({ window, color, now }: { window: UsageWindow; color: string; now: number }) {
  const reset = resetCaption(window.resetsAt, now);
  const tone = windowTone(window);
  return (
    <View style={styles.legend}>
      <View style={styles.legendHead}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <Text variant="caption" color="textMuted" numberOfLines={1} style={styles.flex}>
          {window.label}
        </Text>
      </View>
      <Text
        variant="title"
        tabular
        style={tone === "accent" ? null : { color: USAGE_TONE_COLOR[tone] }}
      >
        {percent(window.usedFraction)}
      </Text>
      {(reset !== null || window.status !== "ok") && (
        <Text
          variant="caption"
          color={window.status !== "ok" ? "danger" : "textFaint"}
          numberOfLines={1}
        >
          {window.status !== "ok" ? `Limited${reset === null ? "" : ` · ${reset}`}` : reset}
        </Text>
      )}
    </View>
  );
}

/** `just now` or `3m ago`. */
function ago(ms: number, now: number): string {
  const rel = relativeTime(ms, now);
  return rel === "now" ? "just now" : `${rel} ago`;
}

/** Why the windows are missing or old, if they are; null when the last fetch was fine. */
function accountNote(account: UsageAccount, now: number): string | null {
  if (account.error !== null && account.windows.length === 0) return account.error;
  if (account.stale) {
    const age = account.fetchedAt === null ? "" : ` from ${ago(account.fetchedAt, now)}`;
    return `Couldn't refresh${account.error === null ? "" : ` (${account.error})`}; showing data${age}`;
  }
  if (account.windows.length === 0) return "No limits reported";
  return null;
}

function AccountCard({ account, now }: { account: UsageAccount; now: number }) {
  const colors = useColors();
  const note = accountNote(account, now);
  const palette = RING_COLORS[account.provider];
  const windows = account.windows.slice(0, palette.length);
  return (
    // Two layers like the table lab's inset-card shell: the header sits on a tinted outer shell,
    // the numbers on a bordered inner card a few points inside it.
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.hairline }]}>
      <View style={styles.cardHead}>
        <View
          style={[
            styles.providerIcon,
            { backgroundColor: colors.surfaceRaised, borderColor: colors.hairline },
          ]}
        >
          <VendorLogo vendor={PROVIDER_VENDOR[account.provider]} size={20} />
        </View>
        <View style={styles.flex}>
          <Text variant="title">{PROVIDER_LABEL[account.provider]}</Text>
          {account.email !== null && (
            <Text variant="caption" color="textMuted" numberOfLines={1}>
              {account.email}
            </Text>
          )}
        </View>
      </View>
      <View
        style={[
          styles.inner,
          { backgroundColor: colors.surfaceRaised, borderColor: colors.hairline },
        ]}
      >
        {windows.length > 0 && (
          <View style={styles.cardBody}>
            <Rings
              size={RING_SIZE}
              rings={windows.map((w, i) => ({
                key: w.id,
                fraction: w.usedFraction,
                color: palette[i] ?? colors.accent,
              }))}
            />
            <View style={styles.legends}>
              {windows.map((w, i) => (
                <WindowLegend key={w.id} window={w} color={palette[i] ?? colors.accent} now={now} />
              ))}
            </View>
          </View>
        )}
        {note !== null && (
          <Text variant="caption" color="textMuted">
            {note}
          </Text>
        )}
      </View>
    </View>
  );
}

export default function Usage() {
  const colors = useColors();
  const usage = useUsageStore((state) => state.usage);
  const connected = useConnectionStore((state) => state.status === "connected");
  const [now, setNow] = useState(() => Date.now());
  // A pull spins until the host's next snapshot, which says whether its refresh is still running.
  const [pulled, setPulled] = useState(false);

  useFocusEffect(
    useCallback(() => {
      requestUsage();
      setNow(Date.now());
    }, []),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    setPulled(false);
    setNow(Date.now());
  }, [usage]);

  const refreshing = pulled || usage?.refreshing === true;
  const groups = usage === null ? [] : groupByProfile(usage.accounts);
  // Opens on the account Home is scoped to; switching here only changes what this page shows.
  const homeProfile = useSettingsStore((state) => state.ompProfile);
  const [profile, setProfile] = useState(homeProfile);
  const group = groups.find((g) => g.profile === profile);

  return (
    <Screen
      title="Usage"
      scroll
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={colors.textMuted}
          onRefresh={() => {
            if (!connected) return;
            setPulled(true);
            refreshUsage();
          }}
        />
      }
    >
      {usage === null || groups.length === 0 ? (
        <EmptyState
          symbol="gauge.with.dots.needle.67percent"
          title={usage === null ? (connected ? "Loading usage…" : "Not connected") : "No accounts"}
          body={
            usage === null
              ? connected
                ? "Asking your Mac for the plan limits of your omp accounts."
                : "Usage comes from your Mac; connect to it to see your plan limits."
              : "Your Mac found no omp accounts."
          }
        />
      ) : (
        <View style={styles.page}>
          <View style={styles.tabs}>
            <SegmentedTabs
              tabs={PROFILE_TABS}
              value={profile}
              size="large"
              onChange={(next) => {
                tapHaptic();
                setProfile(next);
              }}
            />
          </View>
          {group === undefined ? (
            <Text variant="caption" color="textMuted" style={styles.footer}>
              No accounts in this profile
            </Text>
          ) : (
            <View style={styles.cards}>
              {group.accounts.map((account) => (
                <AccountCard key={account.key} account={account} now={now} />
              ))}
            </View>
          )}
          {usage.updatedAt !== null && (
            <Text variant="caption" color="textFaint" style={styles.footer}>
              {usage.refreshing ? "Refreshing…" : `Updated ${ago(usage.updatedAt, now)}`}
            </Text>
          )}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: { paddingBottom: spacing.xxxl, gap: spacing.xl },
  tabs: { paddingHorizontal: spacing.xl },
  cards: { marginHorizontal: spacing.lg, gap: spacing.md },
  card: {
    borderRadius: 26,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    padding: 6,
    gap: 6,
  },
  inner: {
    borderRadius: 20,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.md,
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 4,
  },
  providerIcon: {
    width: 34,
    height: 34,
    borderRadius: 9,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  cardBody: { flexDirection: "row", alignItems: "center", gap: spacing.xl },
  legends: { flex: 1, gap: spacing.md },
  legend: { gap: 1 },
  legendHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  flex: { flex: 1 },
  footer: { textAlign: "center" },
});
