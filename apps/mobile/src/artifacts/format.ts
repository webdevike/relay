/**
 * Pure pieces of the Artifacts sheet: row titles, meta lines, status pills, groups, the subagent
 * tree, media filters, rule chips and the header's blue dot. Which items a tab shows comes from
 * the protocol's `tabItems`, so the phone and the desktop agree; this only decides how they look.
 */
import type { Artifact, ArtifactKind, ArtifactTab, TabRule } from "@relay/protocol";
import { mediaClock } from "@/lib/format";

const DAY = 24 * 60 * 60 * 1000;

/** Tones a pill may take; `handoff` is the purple of merged PRs. */
export type PillTone = "accent" | "ok" | "warn" | "danger" | "textMuted" | "handoff";

export interface Pill {
  label: string;
  tone: PillTone;
}

/** "9:47 PM" today, "Mon 9:47 PM" within the week, else "Oct 25". */
export function artifactTime(ms: number, now: number): string {
  const at = new Date(ms);
  const clock = `${String(at.getHours() % 12 === 0 ? 12 : at.getHours() % 12)}:${String(at.getMinutes()).padStart(2, "0")} ${at.getHours() < 12 ? "AM" : "PM"}`;
  const today = new Date(now);
  if (at.toDateString() === today.toDateString()) return clock;
  if (now - ms < 6 * DAY && ms <= now) return `${at.toLocaleDateString("en-US", { weekday: "short" })} ${clock}`;
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "48x, last 10:50 PM" for an item mentioned more than once, else "last 10:50 PM". */
export function metaLine(item: Artifact, now: number): string {
  const last = `last ${artifactTime(item.lastSeen, now)}`;
  return item.mentions > 1 ? `${String(item.mentions)}x, ${last}` : last;
}

/** The key in front of a row's title: "ENG-6523" for a ticket, "reports-app#241" for a PR or issue. */
export function rowKey(item: Artifact): string | null {
  if (item.kind === "linear") return item.id.slice("linear:".length);
  if (item.kind === "gh-pr" || item.kind === "gh-issue") {
    const hash = item.id.lastIndexOf("#");
    if (hash < 0) return null;
    const repo = item.id.slice(item.id.indexOf(":") + 1, hash);
    return `${repo.slice(repo.lastIndexOf("/") + 1)}${item.id.slice(hash)}`;
  }
  return null;
}

const ACRONYMS: Record<string, true> = { qa: true, pr: true, ui: true, ux: true, api: true };

/** A lower-case Linear state as Linear writes it: "in qa" to "In QA". */
export function stateLabel(state: string): string {
  return state
    .split(" ")
    .map((word) => (ACRONYMS[word.toLowerCase()] === true ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

function ticketTone(item: Artifact): PillTone {
  const status = item.status;
  if (status === undefined) return "textMuted";
  if (status.stateType === "completed") return "ok";
  if (status.stateType === "canceled") return "textMuted";
  if (status.stateType === "started") return /qa|review/i.test(status.state) ? "accent" : "warn";
  return "textMuted";
}

/** The live status as quiet pills: a ticket's state; a PR's state, checks and review. */
export function statusPills(item: Artifact): Pill[] {
  const status = item.status;
  if (status === undefined) return [];
  if (item.kind === "linear") return [{ label: stateLabel(status.state), tone: ticketTone(item) }];
  if (item.kind !== "gh-pr" && item.kind !== "gh-issue") return [];
  const pills: Pill[] = [];
  if (status.state === "merged") pills.push({ label: "Merged", tone: "handoff" });
  else if (status.state === "closed") pills.push({ label: "Closed", tone: "textMuted" });
  else if (status.draft === true) pills.push({ label: "Draft", tone: "textMuted" });
  else pills.push({ label: "Open", tone: "ok" });
  if (status.state === "open") {
    if (status.review === "changes") pills.push({ label: "Changes requested", tone: "warn" });
    else if (status.review === "required" && status.draft !== true) pills.push({ label: "Review required", tone: "accent" });
    else if (status.review === "approved") pills.push({ label: "Approved", tone: "ok" });
    if (status.checks === "fail") pills.push({ label: "Checks failing", tone: "danger" });
    else if (status.checks === "pending") pills.push({ label: "Checks running", tone: "textMuted" });
    else if (status.checks === "pass") pills.push({ label: "Checks pass", tone: "ok" });
  }
  return pills;
}

/** A PR's linked ticket with its state when the thread holds it ("ENG-6525 In Progress"), else just its key. */
export function linkedLine(item: Artifact, items: readonly Artifact[]): string | null {
  const linked = item.status?.linked;
  if (linked === undefined) return null;
  const ticket = items.find((entry) => entry.id === `linear:${linked}`);
  const state = ticket?.status?.state;
  return state === undefined ? linked : `${linked} ${stateLabel(state)}`;
}

const FAMILY: Record<ArtifactKind, string> = {
  linear: "Linear",
  "gh-pr": "GitHub",
  "gh-issue": "GitHub",
  branch: "GitHub",
  url: "Web",
  drop: "Media",
  image: "Media",
  file: "Files",
  experiment: "Files",
  canvas: "Files",
  subagent: "Subagents",
};
const FAMILY_ORDER = ["Linear", "GitHub", "Web", "Media", "Files", "Subagents"];

export interface RowGroup {
  title: string;
  items: Artifact[];
}

/**
 * A list tab's rows in groups: pinned first, then by family (Linear, GitHub, Web, ...) for the
 * default tabs; an agent's tab keeps one group headed by its count ("7 open"). Order within a
 * group is `tabItems`' order.
 */
export function groupRows(tab: ArtifactTab, rows: readonly Artifact[]): RowGroup[] {
  const pinned = rows.filter((item) => item.pinned !== undefined);
  const rest = rows.filter((item) => item.pinned === undefined);
  const groups: RowGroup[] = pinned.length > 0 ? [{ title: "Pinned", items: pinned }] : [];
  if (tab.createdBy !== "default") {
    if (rest.length > 0) groups.push({ title: countLabel(tab, rest.length), items: rest });
    return groups;
  }
  for (const family of FAMILY_ORDER) {
    const items = rest.filter((item) => FAMILY[item.kind] === family);
    if (items.length > 0) groups.push({ title: family, items });
  }
  return groups;
}

/** "7 open" for a rule with one state, else "7 items". */
export function countLabel(tab: ArtifactTab, n: number): string {
  const states = tab.rule?.state;
  if (states?.length === 1 && states[0] !== undefined) return `${String(n)} ${states[0]}`;
  return `${String(n)} ${n === 1 ? "item" : "items"}`;
}

export interface SubagentRow {
  item: Artifact;
  depth: number;
}

/** Subagents in `tabItems` order with each child right under its parent, indented one level per generation. */
export function subagentRows(rows: readonly Artifact[]): SubagentRow[] {
  const ids = new Set(rows.map((item) => item.id));
  const children = new Map<string, Artifact[]>();
  const roots: Artifact[] = [];
  for (const item of rows) {
    const parent = item.subagent?.parent;
    if (parent !== undefined && parent !== item.id && ids.has(parent)) children.set(parent, [...(children.get(parent) ?? []), item]);
    else roots.push(item);
  }
  const out: SubagentRow[] = [];
  const seen = new Set<string>();
  const walk = (item: Artifact, depth: number): void => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    out.push({ item, depth });
    for (const child of children.get(item.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  // A parent cycle leaves rows no root reaches; show them flat rather than lose them.
  for (const item of rows) walk(item, 0);
  return out;
}

/** True while any subagent of the thread runs (the Subagents tab spins). */
export function anySubagentRunning(items: readonly Artifact[]): boolean {
  return items.some((item) => item.subagent?.state === "running");
}

export type MediaFilter = "all" | "images" | "videos" | "mine";

export const MEDIA_FILTERS: readonly { id: MediaFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "images", label: "Images" },
  { id: "videos", label: "Videos" },
  { id: "mine", label: "From you" },
];

export function isVideo(item: Artifact): boolean {
  return item.media?.mimeType.startsWith("video/") === true;
}

/** Media tiles newest first, narrowed by the filter chip. */
export function mediaTiles(rows: readonly Artifact[], filter: MediaFilter): Artifact[] {
  return rows
    .filter((item) => {
      if (filter === "images") return item.media !== undefined && !isVideo(item);
      if (filter === "videos") return isVideo(item);
      if (filter === "mine") return item.from === "user";
      return true;
    })
    .sort((a, b) => b.firstSeen - a.firstSeen);
}

/** A video's length as m:ss, or null. */
export function videoLength(item: Artifact): string | null {
  const ms = item.media?.durationMs;
  return isVideo(item) && ms !== undefined ? mediaClock(ms / 1000) : null;
}

/** An http(s) URL as is; a host path (`/drops/...`, `/artifacts/media/...`) on `base`, or null while offline. */
export function hostUrl(url: string | undefined, base: string | null): string | null {
  if (url === undefined) return null;
  if (!url.startsWith("/")) return url;
  return base === null ? null : `${base}${url}`;
}

const KIND_LABEL: Record<ArtifactKind, string> = {
  linear: "Linear ticket",
  "gh-pr": "GitHub PR",
  "gh-issue": "GitHub issue",
  url: "Link",
  drop: "Drop",
  image: "Image",
  file: "File",
  experiment: "Experiment",
  canvas: "Canvas",
  branch: "Branch",
  subagent: "Subagent",
};

/** An agent tab's rule as chips, in the desktop's order: kinds, states, then the narrower fields. */
export function ruleChips(rule: TabRule | undefined): string[] {
  if (rule === undefined) return [];
  const chips: string[] = [];
  for (const kind of rule.kind ?? []) chips.push(KIND_LABEL[kind]);
  for (const state of rule.state ?? []) chips.push(state);
  if (rule.repo !== undefined) chips.push(rule.repo);
  if (rule.caption !== undefined) chips.push(`"${rule.caption}"`);
  if (rule.media === true) chips.push("Media");
  if (rule.pinned === true) chips.push("Pinned");
  if (rule.since !== undefined) chips.push(`since ${new Date(rule.since).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`);
  return chips;
}

/** "Added by Astra at 10:41 PM": who made an agent tab and when. */
export function makerLine(tab: ArtifactTab, nameOf: (agent: string) => string, now: number): string {
  const who = tab.createdBy === "isaac" ? "you" : nameOf(tab.createdBy);
  return `Added by ${who} at ${artifactTime(tab.createdAt, now)}`;
}

/** Every item whose title, key, caption or URL holds `query` (faded ones too), newest first. */
export function searchArtifacts(items: readonly Artifact[], query: string): Artifact[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  return items
    .filter((item) => [item.title, item.id, item.caption ?? "", item.url ?? ""].some((field) => field.toLowerCase().includes(q)))
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

/** A subagent row's second line: what it is doing, else how it ended. */
export function subagentLine(item: Artifact, now: number): string {
  const sub = item.subagent;
  if (sub === undefined) return metaLine(item, now);
  if (sub.line !== undefined && sub.state === "running") return sub.line;
  if (sub.state === "running") return `started ${artifactTime(sub.startedAt, now)}`;
  const end = artifactTime(sub.endedAt ?? item.lastSeen, now);
  return sub.state === "failed" ? `failed ${end}` : `done ${end}`;
}

/**
 * The header button's blue dot: something arrived since the sheet was last opened on this thread
 * (`seenAt`, null before the first open), or an agent added a tab Isaac has not opened.
 */
export function hasNewArtifacts(items: readonly Artifact[], tabs: readonly ArtifactTab[], seenAt: number | null): boolean {
  if (tabs.some((tab) => tab.fresh === true && !tab.hidden)) return true;
  if (seenAt === null) return items.length > 0;
  return items.some((item) => item.firstSeen > seenAt);
}

/**
 * Where "Move left/right" puts `tab` in the full bar (hidden tabs included): the slot of the
 * nearest visible tab on that side, or null at the end of the bar.
 */
export function moveIndex(tabs: readonly ArtifactTab[], tab: string, direction: -1 | 1): number | null {
  const from = tabs.findIndex((entry) => entry.id === tab);
  if (from < 0) return null;
  for (let i = from + direction; i >= 0 && i < tabs.length; i += direction) {
    if (tabs[i]?.hidden === false) return i;
  }
  return null;
}

/** The tab the sheet opens on: the last one shown if still visible, else the first visible tab with rows. */
export function initialTab(visible: readonly ArtifactTab[], counts: Readonly<Record<string, number>>, last: string | null): string | null {
  if (last !== null && visible.some((tab) => tab.id === last)) return last;
  return (visible.find((tab) => (counts[tab.id] ?? 0) > 0) ?? visible[0])?.id ?? null;
}
