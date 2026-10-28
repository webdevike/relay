/**
 * Pure pieces of the Artifacts sheet: row titles, meta lines, status pills, groups, the subagent
 * tree, the Subagents tab's task groups, media tiles, rule chips and the header's blue dot. Which
 * items a tab shows comes from the protocol's `tabItems`, so the phone and the desktop agree; this
 * only decides how they look.
 */
import { artifactFaded, compareArtifacts, type AgentApproval, type AgentAsk, type AgentSession, type Artifact, type ArtifactKind, type ArtifactTab, type AssistantAgent, type TabRule } from "@relay/protocol";
import { elapsed, mediaClock } from "@/lib/format";

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

/** The key in front of a row's title: "ENG-6523" for a ticket, "#241" for a PR or issue (its repo leads the second line, `repoName`). */
export function rowKey(item: Artifact): string | null {
  if (item.kind === "linear") return item.id.slice("linear:".length);
  if (item.kind === "gh-pr" || item.kind === "gh-issue") {
    const hash = item.id.lastIndexOf("#");
    return hash < 0 ? null : item.id.slice(hash);
  }
  return null;
}

/** A PR, issue or branch's repo without its owner ("react-client-reports-app"), or null. */
export function repoName(item: Artifact): string | null {
  const repo = item.repo ?? (item.kind === "gh-pr" || item.kind === "gh-issue" ? item.id.slice(item.id.indexOf(":") + 1, item.id.lastIndexOf("#")) : "");
  return repo === "" ? null : repo.slice(repo.lastIndexOf("/") + 1);
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

export function isVideo(item: Artifact): boolean {
  return item.media?.mimeType.startsWith("video/") === true;
}

/** Media tiles newest first. */
export function mediaTiles(rows: readonly Artifact[]): Artifact[] {
  return [...rows].sort((a, b) => b.firstSeen - a.firstSeen);
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

/** Where a task row stands; the sheet draws its glyph and tone from this. */
export type TaskState = "ask" | "approval" | "waiting" | "review" | "running" | "done" | "failed";

/** What tapping a task row does: close the sheet (answer in the chat), open a URL, or push a subagent's session; null when it has nowhere to go. */
export type TaskOpen = { kind: "close" } | { kind: "url"; url: string } | { kind: "session"; sessionId: string } | null;

export interface TaskRow {
  key: string;
  state: TaskState;
  title: string;
  line: string;
  /** Epoch ms the time column counts from (`elapsed`) or shows (`clock`); null for no time. */
  at: number | null;
  timeStyle: "elapsed" | "clock";
  tone: PillTone | "working";
  /** Nesting under a parent subagent in the Working group. */
  depth: number;
  open: TaskOpen;
}

export type TaskGroupId = "needs" | "review" | "working" | "resolved";

export interface TaskGroup {
  id: TaskGroupId;
  title: string;
  rows: TaskRow[];
}

export interface TaskInputs {
  /** The thread's artifacts, faded ones included (they are dropped here). */
  items: readonly Artifact[];
  now: number;
  /** The omp session the thread runs in, or null while it is not running. */
  threadSession: string | null;
  sessions: Readonly<Record<string, AgentSession>>;
  ask: AgentAsk | undefined;
  approval: AgentApproval | undefined;
  /** The thread's assistant as the registry lists it. */
  agent: AssistantAgent | undefined;
  agentTitle: string;
}

const TASK_TITLES: Record<TaskGroupId, string> = {
  needs: "Needs input",
  review: "Ready for review",
  working: "Working",
  resolved: "Resolved",
};

function present(text: string | undefined): string | null {
  const trimmed = text?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}

/** The one row for a thread blocked on Isaac: its pending ask, else its approval, else a waiting session, else the registry's needs-you. */
function needsRow({ threadSession, sessions, ask, approval, agent, agentTitle }: TaskInputs): TaskRow | null {
  const session = threadSession === null ? undefined : sessions[threadSession];
  const base = { key: `needs:${threadSession ?? agent?.id ?? ""}`, at: session?.lastActivityAt ?? agent?.lastReply?.at ?? null, timeStyle: "clock" as const, tone: "warn" as const, depth: 0, open: { kind: "close" as const } };
  if (ask !== undefined) return { ...base, state: "ask", title: `${agentTitle} asked you`, line: ask.questions[0]?.question ?? "" };
  if (approval !== undefined) return { ...base, state: "approval", title: `Approve ${approval.toolName}`, line: present(approval.command) ?? present(approval.reason) ?? approval.toolName };
  if (session !== undefined && (session.status === "waiting" || session.status === "needs_permission")) {
    return { ...base, state: "waiting", title: `${agentTitle} needs you`, line: present(session.statusDetail) ?? present(session.lastActivity) ?? "Waiting on you" };
  }
  if (agent?.status === "needs_you") return { ...base, state: "waiting", title: `${agentTitle} needs you`, line: present(agent.lastReply?.text) ?? "Waiting on you" };
  return null;
}

/** An open PR's review state and checks as one line: "Review requested · Checks pass · relay #241". */
export function reviewLine(item: Artifact): string {
  const pills = statusPills(item).map((pill) => (pill.label === "Review required" ? "Review requested" : pill.label));
  // "Open" says nothing in a group of open PRs; keep it only when nothing else describes the PR.
  const said = pills.filter((label) => label !== "Open");
  const key = rowKey(item);
  const where = [repoName(item), key].filter((part) => part !== null).join(" ");
  return [...(said.length > 0 ? said : ["Open"]), ...(where === "" ? [] : [where])].join(" · ");
}

function reviewTone(item: Artifact): PillTone {
  const status = item.status;
  if (status?.checks === "fail") return "danger";
  if (status?.review === "changes") return "warn";
  if (status?.draft === true) return "textMuted";
  return "accent";
}

/** The mirrored session of a subagent item (`<thread session>:<name>`, relay-bridge `mirrorSubagent`), if the host still lists it. */
export function subagentSession(item: Artifact, threadSession: string | null, sessions: Readonly<Record<string, AgentSession>>): AgentSession | undefined {
  if (threadSession === null) return undefined;
  const file = item.path ?? item.id.slice("subagent:".length);
  const name = file.slice(file.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");
  const session = sessions[`${threadSession}:${name}`];
  return session?.parentId === threadSession ? session : undefined;
}

function resolvedLine(item: Artifact, session: AgentSession | undefined): string {
  const failed = item.subagent?.state === "failed";
  const summary = present(session?.lastActivity);
  if (summary === null) return failed ? "Failed" : "Done";
  return failed ? `Failed · ${summary}` : summary;
}

/**
 * The Subagents tab as task states, in order: Needs input (the thread blocked on Isaac), Ready for
 * review (its open PRs), Working (running subagents, children under their parent) and Resolved
 * (subagents that finished today, newest first). Groups with no rows are left out.
 */
export function taskGroups(input: TaskInputs): TaskGroup[] {
  const { items, now, threadSession, sessions } = input;
  const shown = items.filter((item) => !artifactFaded(item, now)).sort(compareArtifacts);
  const needs = needsRow(input);
  const review: TaskRow[] = shown
    .filter((item) => item.kind === "gh-pr" && item.status?.state === "open")
    .map((item) => ({
      key: item.id,
      state: "review",
      title: item.title,
      line: reviewLine(item),
      at: item.status?.changedAt ?? item.lastSeen,
      timeStyle: "clock",
      tone: reviewTone(item),
      depth: 0,
      open: item.url !== undefined && /^https?:/.test(item.url) ? { kind: "url", url: item.url } : null,
    }));
  const subagents = shown.filter((item) => item.kind === "subagent" && item.subagent !== undefined);
  const working: TaskRow[] = subagentRows(subagents.filter((item) => item.subagent?.state === "running")).map(({ item, depth }) => {
    const session = subagentSession(item, threadSession, sessions);
    return {
      key: item.id,
      state: "running",
      title: item.title,
      line: present(session?.statusDetail) ?? present(session?.lastActivity) ?? subagentLine(item, now),
      at: item.subagent?.startedAt ?? item.firstSeen,
      timeStyle: "elapsed",
      tone: "working",
      depth,
      open: session === undefined ? null : { kind: "session", sessionId: session.id },
    };
  });
  const ended = (item: Artifact): number => item.subagent?.endedAt ?? item.lastSeen;
  const resolved: TaskRow[] = subagents
    .filter((item) => item.subagent?.state !== "running")
    .sort((a, b) => ended(b) - ended(a))
    .map((item) => {
      const session = subagentSession(item, threadSession, sessions);
      const failed = item.subagent?.state === "failed";
      return {
        key: item.id,
        state: failed ? "failed" : "done",
        title: item.title,
        line: resolvedLine(item, session),
        at: ended(item),
        timeStyle: "clock",
        tone: failed ? "danger" : "ok",
        depth: 0,
        open: session === undefined ? null : { kind: "session", sessionId: session.id },
      };
    });
  const groups: Record<TaskGroupId, TaskRow[]> = { needs: needs === null ? [] : [needs], review, working, resolved };
  return (Object.keys(TASK_TITLES) as TaskGroupId[]).filter((id) => groups[id].length > 0).map((id) => ({ id, title: TASK_TITLES[id], rows: groups[id] }));
}

/** A task row's time: how long it has run while working, else the clock time it happened. */
export function taskTime(row: TaskRow, now: number): string | null {
  if (row.at === null) return null;
  return row.timeStyle === "elapsed" ? elapsed(now - row.at) : artifactTime(row.at, now);
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
