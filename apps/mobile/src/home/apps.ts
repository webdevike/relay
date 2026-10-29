/**
 * Home's apps: one entry per thing the phone can do with the host, each with its live fact, drawn
 * by the `apps` widget like iOS Settings rows. A red badge marks what needs the user (inbox
 * sessions waiting on them, a plan limit near, host input unavailable).
 */
import type { SFSymbol } from "expo-symbols";
import type { Href } from "expo-router";
import type { ICON_COLORS } from "@/home/AppRow";
import { useBoardsStore } from "@/state/boards";
import { studioJobActive } from "@relay/protocol";
import { useStudioStore } from "@/state/studio";
import { useConnectionStore } from "@/state/connection";
import { needsAttention, useAgentsStore } from "@/state/agents";
import { assistantsCaption, useAssistantStore } from "@/state/assistant";
import { useUsageStore } from "@/state/usage";
import { countOf } from "@/lib/format";
import { USAGE_WARN, usageHint, usagePeak } from "@/lib/usage";

export interface HomeApp {
  key: string;
  symbol: SFSymbol;
  label: string;
  color: keyof typeof ICON_COLORS;
  /** One-line live fact under the name. */
  hint: string;
  /** Trailing count when nothing needs the user. */
  value?: number;
  /** Red badge: a count, or `!` for a problem. */
  badge?: number | "!";
  href: Href;
}

function inboxCaption(available: boolean, sessions: number, needing: number): string {
  if (!available) return "Host has no agent bridge";
  if (sessions === 0) return "No sessions";
  const base = countOf(sessions, "session");
  if (needing === 0) return base;
  return `${base}, ${needing} ${needing === 1 ? "needs" : "need"} you`;
}

export function useHomeApps(): HomeApp[] {
  const boards = useBoardsStore((state) => state.boards);
  const mac = useConnectionStore((state) => state.mac);
  const macName = useConnectionStore((state) => state.macName);
  const agentsAvailable = mac?.agentsAvailable === true;
  const sessions = useAgentsStore((state) => state.sessions);
  const order = useAgentsStore((state) => state.order);
  const needingCount = order.filter((id) => {
    const session = sessions[id];
    return session !== undefined && needsAttention(session);
  }).length;
  // The host's registry, asked on every welcome and kept live by the host; none until the first answer.
  const assistantsLine = useAssistantStore((state) => assistantsCaption(state.agents));
  // Asked on every welcome; the highest window across every account is the line worth a glance.
  const usage = useUsageStore((state) => state.usage);
  // Jobs the host is still making; pushed live while connected.
  const studioActive = useStudioStore((state) => state.jobs.filter(studioJobActive).length);
  const usageTop = usagePeak(usage);
  const hostLine =
    mac === null
      ? "Waiting for a host"
      : `${macName ?? "Host"} v${mac.version}, input ${mac.accessibilityGranted ? "ready" : "unavailable"}`;
  return [
    {
      key: "assistants",
      symbol: "bubble.left.and.text.bubble.right.fill",
      label: "Assistants",
      color: "blue",
      hint: assistantsLine,
      href: "/assistants",
    },
    {
      key: "inbox",
      symbol: "tray.fill",
      label: "Inbox",
      color: "orange",
      hint: inboxCaption(agentsAvailable, order.length, needingCount),
      ...(agentsAvailable ? { value: order.length } : {}),
      ...(needingCount > 0 ? { badge: needingCount } : {}),
      href: "/agents",
    },
    {
      key: "usage",
      symbol: "gauge.with.dots.needle.67percent",
      label: "Usage",
      color: "pink",
      hint: usageHint(usage),
      ...(usageTop !== null && usageTop.window.usedFraction >= USAGE_WARN
        ? { badge: "!" as const }
        : {}),
      href: "/usage",
    },
    {
      key: "screen",
      symbol: "display",
      label: "Live view",
      color: "indigo",
      hint: "See and control your Mac",
      href: "/screen",
    },
    {
      key: "trackpad",
      symbol: "cursor.rays",
      label: "Trackpad",
      color: "teal",
      hint: "Move, click, scroll",
      href: "/trackpad",
    },
    {
      key: "boards",
      symbol: "chart.xyaxis.line",
      label: "Boards",
      color: "green",
      hint:
        boards.length === 0
          ? "Live dashboards from the host"
          : boards.map((b) => b.title).join(", "),
      ...(boards.length > 0 ? { value: boards.length } : {}),
      href: "/boards",
    },
    {
      key: "studio",
      symbol: "wand.and.stars",
      label: "Studio",
      color: "pink",
      hint: studioActive === 0 ? "Make images and video" : `${studioActive} running`,
      ...(studioActive > 0 ? { value: studioActive } : {}),
      href: "/studio",
    },
    {
      key: "settings",
      symbol: "gearshape.fill",
      label: "Settings",
      color: "gray",
      hint: hostLine,
      ...(mac !== null && !mac.accessibilityGranted ? { badge: "!" as const } : {}),
      href: "/settings",
    },
  ];
}
