import { describe, expect, it } from "vitest";
import type { UsageAccount, UsageSnapshot, UsageWindow } from "@relay/protocol";
import { groupByProfile, resetCaption, usageHint, usagePeak, windowTone } from "./usage";

function window(id: string, usedFraction: number, status = "ok"): UsageWindow {
  return { id, label: id, usedFraction, resetsAt: null, status };
}

function account(profile: string, provider: UsageAccount["provider"], windows: UsageWindow[]): UsageAccount {
  return {
    key: `${profile}:${provider}`,
    profile,
    profileLabel: profile === "work" ? "Work" : "Personal",
    provider,
    email: null,
    windows,
    fetchedAt: 1,
    stale: false,
    error: null,
  };
}

const snapshot: UsageSnapshot = {
  accounts: [
    account("work", "anthropic", [window("5 hours", 0.11), window("7 days", 0.78)]),
    account("personal", "anthropic", [window("5 hours", 0.03)]),
    account("work", "openai-codex", [window("7 days", 0)]),
    account("personal", "openai-codex", []),
  ],
  updatedAt: 1,
  refreshing: false,
};

describe("windowTone", () => {
  it("warns from 80% and is danger when limited or full", () => {
    expect(windowTone(window("a", 0.79))).toBe("accent");
    expect(windowTone(window("a", 0.8))).toBe("warn");
    expect(windowTone(window("a", 1))).toBe("danger");
    expect(windowTone(window("a", 0.2, "exhausted"))).toBe("danger");
  });
});

describe("resetCaption", () => {
  const now = new Date(2026, 9, 23, 12, 0).getTime();

  it("counts down within a day", () => {
    expect(resetCaption(now + (3 * 60 + 12) * 60_000, now)).toBe("Resets in 3h 12m");
    expect(resetCaption(now + 2 * 3_600_000, now)).toBe("Resets in 2h");
    expect(resetCaption(now + 5 * 60_000, now)).toBe("Resets in 5m");
  });

  it("names the weekday and time beyond a day", () => {
    expect(resetCaption(new Date(2026, 9, 27, 9, 0).getTime(), now)).toBe("Resets Tue 9:00");
  });

  it("is null without a time", () => {
    expect(resetCaption(null, now)).toBeNull();
  });
});

describe("groupByProfile", () => {
  it("groups provider-major accounts into profiles in first-seen order", () => {
    const groups = groupByProfile(snapshot.accounts);
    expect(groups.map((g) => g.label)).toEqual(["Work", "Personal"]);
    expect(groups[0]?.accounts.map((a) => a.provider)).toEqual(["anthropic", "openai-codex"]);
  });
});

describe("usagePeak / usageHint", () => {
  it("finds the most used window across accounts", () => {
    expect(usagePeak(snapshot)?.window.id).toBe("7 days");
    expect(usageHint(snapshot)).toBe("Claude 78% of 7 days · Work");
  });

  it("reads a placeholder before the first snapshot", () => {
    expect(usagePeak(null)).toBeNull();
    expect(usageHint(null)).toBe("Plan limits of your accounts");
  });
});
