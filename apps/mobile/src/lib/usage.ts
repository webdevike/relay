/** Pure helpers for the Usage screen, Home's Usage row and its widget. */
import type { UsageAccount, UsageProvider, UsageSnapshot, UsageWindow } from "@relay/protocol";

export const PROVIDER_LABEL: Record<UsageProvider, string> = {
  anthropic: "Claude",
  "openai-codex": "Codex",
};

/** Ring colours per provider, outer ring first (5 hours, 7 days, then a tier window). */
export const RING_COLORS: Record<UsageProvider, readonly string[]> = {
  anthropic: ["#FF7A45", "#FFB547", "#FF4D88"],
  "openai-codex": ["#3E9BFF", "#3FD6C6", "#8A7CFF"],
};

/** The app's vendor logo for each provider (Codex is OpenAI's). */
export const PROVIDER_VENDOR: Record<UsageProvider, string> = {
  anthropic: "anthropic",
  "openai-codex": "openai",
};

/** Figure colour of a nearly spent (warn) or limited (danger) window; plain text otherwise. */
export const USAGE_TONE_COLOR: Record<Exclude<UsageTone, "accent">, string> = {
  warn: "#FFB020",
  danger: "#FF453A",
};

/** At or past this share a window reads as nearly spent. */
export const USAGE_WARN = 0.8;

export type UsageTone = "accent" | "warn" | "danger";

/** Limited (omp says so, or fully used) is danger; nearly spent is warn. */
export function windowTone(window: UsageWindow): UsageTone {
  if (window.status !== "ok" || window.usedFraction >= 1) return "danger";
  if (window.usedFraction >= USAGE_WARN) return "warn";
  return "accent";
}

export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** `Resets in 3h 12m` within a day, else `Resets Tue 9:00` (local time); null when omp gave no time. */
export function resetCaption(resetsAt: number | null, now: number = Date.now()): string | null {
  if (resetsAt === null) return null;
  const left = resetsAt - now;
  if (left <= 0) return "Resetting now";
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) return `Resets in ${minutes}m`;
  if (minutes < 24 * 60) {
    const rest = minutes % 60;
    return `Resets in ${Math.floor(minutes / 60)}h${rest === 0 ? "" : ` ${rest}m`}`;
  }
  const at = new Date(resetsAt);
  return `Resets ${WEEKDAYS[at.getDay()]} ${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
}

export interface ProfileGroup {
  profile: string;
  label: string;
  accounts: UsageAccount[];
}

/** Accounts grouped by profile (Work first, then Personal, then any other), accounts in snapshot order within each. */
export function groupByProfile(accounts: readonly UsageAccount[]): ProfileGroup[] {
  const groups: ProfileGroup[] = [];
  for (const account of accounts) {
    let group = groups.find((g) => g.profile === account.profile);
    if (group === undefined) {
      group = { profile: account.profile, label: account.profileLabel, accounts: [] };
      groups.push(group);
    }
    group.accounts.push(account);
  }
  const rank = (p: string): number => (p === "work" ? 0 : p === "personal" ? 1 : 2);
  return groups.sort((a, b) => rank(a.profile) - rank(b.profile));
}

export interface UsagePeak {
  account: UsageAccount;
  window: UsageWindow;
}

/** The most used window across every account; null when no account has any. */
export function usagePeak(snapshot: UsageSnapshot | null): UsagePeak | null {
  let peak: UsagePeak | null = null;
  for (const account of snapshot?.accounts ?? []) {
    for (const window of account.windows) {
      if (peak === null || window.usedFraction > peak.window.usedFraction) peak = { account, window };
    }
  }
  return peak;
}

/** Per provider, in first-seen order, the account whose most used window is fullest (the first on a tie). */
export function busiestByProvider(accounts: readonly UsageAccount[]): UsageAccount[] {
  const most = (account: UsageAccount): number => Math.max(-1, ...account.windows.map((w) => w.usedFraction));
  const busiest = new Map<UsageProvider, UsageAccount>();
  for (const account of accounts) {
    const held = busiest.get(account.provider);
    if (held === undefined || most(account) > most(held)) busiest.set(account.provider, account);
  }
  return [...busiest.values()];
}

/** Home's one-line fact: `Claude 78% of 7 days · Work`. */
export function usageHint(snapshot: UsageSnapshot | null): string {
  if (snapshot === null) return "Plan limits of your accounts";
  const peak = usagePeak(snapshot);
  if (peak === null) return snapshot.accounts.length === 0 ? "No accounts" : "No usage data";
  return `${PROVIDER_LABEL[peak.account.provider]} ${percent(peak.window.usedFraction)} of ${peak.window.label} · ${peak.account.profileLabel}`;
}
