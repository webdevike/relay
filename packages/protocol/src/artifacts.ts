// Artifacts: what a thread holds, collected per thread by the host. Linear tickets and GitHub PRs
// (with live state), web links, drops and pasted images, files, Test Bench runs, canvases,
// branches and subagents, one row per key however often the thread mentions it.
//
// The host is the only writer. It mines each thread's omp transcripts (`extract.ts` on the host),
// keeps `artifacts.json` (items) and `tabs.json` (tab bar) per thread under
// `$XDG_CONFIG_HOME/relay/artifacts/<thread>/`, and pushes the thread's `artifacts.snapshot` to every
// device after each change. Clients change things with `artifacts.act` (pins, tabs, items Isaac or
// an agent adds, and the live statuses Relay desktop reads from gh and Linear).
//
// Tabs: the four defaults come first (Subagents, Links, Media, Everything); agents add tabs after
// them with a rule (`{kind:["gh-pr"], state:["open"]}`) or an explicit item list. A tab whose rule
// matches a default, or one Isaac hid, is refused: hide is sticky and agents reuse the defaults.
// Both clients draw a tab with `tabItems`, so the phone and the desktop always agree.
//
// Pure module: zod only, no imports from the rest of the protocol (index.ts re-exports it).
import { z } from "zod";

const ms = z.number().finite();

export const ARTIFACT_KINDS = [
  "linear",
  "gh-pr",
  "gh-issue",
  "url",
  "drop",
  "image",
  "file",
  "experiment",
  "canvas",
  "branch",
  "subagent",
] as const;
export const ArtifactKind = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

/** The same thread key reactions use: `assistant:<agent id>` or `session:<omp session id>`. */
export const ArtifactThread = z.string().regex(/^(?:assistant:[a-z][a-z0-9-]*|session:\S+)$/);
export type ArtifactThread = z.infer<typeof ArtifactThread>;

/** Who did something: `isaac`, `extractor` (the host's miner), `default` (a built-in tab) or an agent id / chat name. */
export const ArtifactActor = z.string().min(1).max(64);

/** Icons a tab may carry; each client maps them to its own icon set. */
export const ARTIFACT_TAB_ICONS = [
  "robot",
  "link",
  "photo",
  "stack",
  "git-pull-request",
  "ticket",
  "file",
  "flask",
  "layout",
  "star",
  "check",
  "video",
  "bug",
  "rocket",
] as const;
export const ArtifactTabIcon = z.enum(ARTIFACT_TAB_ICONS);
export type ArtifactTabIcon = z.infer<typeof ArtifactTabIcon>;

/**
 * Live state of a ticket or PR, written by Relay desktop (gh and the Linear API) through
 * `artifacts.act {op:"status"}`. `state` is lower case: a PR's `open` | `merged` | `closed`, a Linear
 * state name (`in progress`, `done`). `stateType` is Linear's category.
 */
export const ArtifactStatus = z.object({
  state: z.string().min(1).max(40),
  stateType: z.enum(["triage", "backlog", "unstarted", "started", "completed", "canceled"]).optional(),
  draft: z.boolean().optional(),
  /** The ticket's or PR's title as gh / Linear give it; the host moves it to the item's `title`. */
  title: z.string().min(1).max(300).optional(),
  /** Combined checks of a PR: any failing is `fail`, else any pending is `pending`. */
  checks: z.enum(["pass", "fail", "pending"]).optional(),
  review: z.enum(["approved", "changes", "required"]).optional(),
  assignee: z.string().max(80).optional(),
  /** The Linear key a PR names in its branch or title, so its row can show the ticket's state. */
  linked: z.string().max(20).optional(),
  fetchedAt: ms,
  /** When `state` last changed (epoch ms); merged PRs and done tickets fade two days after it. */
  changedAt: ms.optional(),
});
export type ArtifactStatus = z.infer<typeof ArtifactStatus>;

export const ArtifactPin = z.object({ by: ArtifactActor, at: ms });
export type ArtifactPin = z.infer<typeof ArtifactPin>;

export const ArtifactMedia = z.object({
  mimeType: z.string().min(1).max(100),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  /** A video drop's poster: `<url>/poster`. */
  poster: z.string().min(1).max(2048).optional(),
});
export type ArtifactMedia = z.infer<typeof ArtifactMedia>;

export const SubagentState = z.enum(["running", "done", "failed"]);
export type SubagentState = z.infer<typeof SubagentState>;

export const ArtifactSubagent = z.object({
  state: SubagentState,
  /** The parent subagent's item id when this one was spawned by a subagent. */
  parent: z.string().max(512).optional(),
  /** Its latest status line (the intent of its last tool call). */
  line: z.string().max(200).optional(),
  startedAt: ms,
  endedAt: ms.optional(),
});
export type ArtifactSubagent = z.infer<typeof ArtifactSubagent>;

/** Bubble keys (`<role>@<omp ms>`) of the newest messages that mention an item. */
export const MAX_ARTIFACT_SOURCES = 5;
/** Items per thread; past it the least recently seen unpinned items go. */
export const MAX_ARTIFACTS = 2000;
export const MAX_ARTIFACT_TABS = 24;

/**
 * One thing a thread holds. `id` is its dedupe key: `linear:ENG-6523`,
 * `gh-pr:eCardSystems/react-client-reports-app#238`, `gh-issue:<repo>#<n>`, `drop:<uuid>`,
 * `image:<sha>`, `url:<normalized url>`, `file:<absolute path>`, `experiment:<dir>`,
 * `canvas:<slug>`, `branch:<name>`, `subagent:<transcript path>`.
 */
export const Artifact = z.object({
  id: z.string().min(1).max(2100),
  kind: ArtifactKind,
  title: z.string().min(1).max(300),
  /** http(s) URL, or a host path (`/drops/<id>/<token>`, `/artifacts/media/<sha>/<token>`) clients prefix with the host. */
  url: z.string().min(1).max(2048).optional(),
  /** File, experiment dir, canvas file or subagent transcript on the Mac. */
  path: z.string().min(1).max(1024).optional(),
  /** `owner/name` for PRs, issues and branches. */
  repo: z.string().max(200).optional(),
  /** Alt text of a media embed. */
  caption: z.string().max(300).optional(),
  media: ArtifactMedia.optional(),
  subagent: ArtifactSubagent.optional(),
  /** Messages that mention it (each message counts once). */
  mentions: z.number().int().nonnegative(),
  firstSeen: ms,
  lastSeen: ms,
  sources: z.array(z.string().max(40)).max(MAX_ARTIFACT_SOURCES),
  addedBy: ArtifactActor,
  /** Who first brought it into the thread: Isaac (`user`) or the agent (`assistant`). */
  from: z.enum(["user", "assistant"]).optional(),
  pinned: ArtifactPin.optional(),
  status: ArtifactStatus.optional(),
});
export type Artifact = z.infer<typeof Artifact>;

/**
 * A tab's rule; every field present must match (fields are ANDed, list entries ORed).
 * `state` matches the PR/ticket/subagent state or Linear's state category; `caption` is a
 * case-insensitive substring of caption or title (`before|after` means either); `repo` is
 * `owner/name` or just `name`; `since` keeps items seen at or after it.
 */
export const TabRule = z
  .object({
    kind: z.array(ArtifactKind).min(1).max(ARTIFACT_KINDS.length).optional(),
    state: z.array(z.string().min(1).max(40)).min(1).max(12).optional(),
    caption: z.string().min(1).max(120).optional(),
    repo: z.string().min(1).max(200).optional(),
    since: ms.optional(),
    media: z.boolean().optional(),
    pinned: z.boolean().optional(),
  })
  .strict();
export type TabRule = z.infer<typeof TabRule>;

export const ArtifactTab = z.object({
  /** `subagents` | `links` | `media` | `everything` for the defaults; a slug for the rest. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
  title: z.string().trim().min(1).max(40),
  icon: ArtifactTabIcon.optional(),
  /** `default`, `isaac`, or the agent that made it. */
  createdBy: ArtifactActor,
  createdAt: ms,
  /** Exactly one of `rule` and `items`; `everything` has an empty rule. */
  rule: TabRule.optional(),
  items: z.array(z.string().min(1).max(2100)).max(500).optional(),
  hidden: z.boolean(),
  /** Set when an agent adds the tab; cleared the first time Isaac opens it (the blue dot). */
  fresh: z.boolean().optional(),
});
export type ArtifactTab = z.infer<typeof ArtifactTab>;

export const DEFAULT_TAB_IDS = ["subagents", "links", "media", "everything"] as const;
export type DefaultTabId = (typeof DEFAULT_TAB_IDS)[number];

export const DEFAULT_TAB_RULES: Readonly<Record<DefaultTabId, TabRule>> = {
  subagents: { kind: ["subagent"] },
  links: { kind: ["linear", "gh-pr", "gh-issue", "url", "branch"] },
  media: { media: true },
  everything: {},
};

const DEFAULT_TAB_LOOK: Readonly<Record<DefaultTabId, { title: string; icon: ArtifactTabIcon }>> = {
  subagents: { title: "Subagents", icon: "robot" },
  links: { title: "Links", icon: "link" },
  media: { title: "Media", icon: "photo" },
  everything: { title: "Everything", icon: "stack" },
};

export function isDefaultTab(id: string): id is DefaultTabId {
  return (DEFAULT_TAB_IDS as readonly string[]).includes(id);
}

/** The tab bar of a thread nobody has changed. */
export function defaultTabs(): ArtifactTab[] {
  return DEFAULT_TAB_IDS.map((id) => ({ id, ...DEFAULT_TAB_LOOK[id], createdBy: "default", createdAt: 0, rule: DEFAULT_TAB_RULES[id], hidden: false }));
}

/** A rule with its lists sorted and lower-cased, so two rules compare by meaning. */
export function normalizeRule(rule: TabRule): TabRule {
  const out: TabRule = {};
  if (rule.kind !== undefined) out.kind = [...new Set(rule.kind)].sort();
  if (rule.state !== undefined) out.state = [...new Set(rule.state.map((s) => s.toLowerCase().trim()))].sort();
  if (rule.caption !== undefined) out.caption = rule.caption.toLowerCase().trim();
  if (rule.repo !== undefined) out.repo = rule.repo.toLowerCase().trim();
  if (rule.since !== undefined) out.since = rule.since;
  if (rule.media !== undefined) out.media = rule.media;
  if (rule.pinned !== undefined) out.pinned = rule.pinned;
  return out;
}

export function sameRule(a: TabRule, b: TabRule): boolean {
  return JSON.stringify(normalizeRule(a)) === JSON.stringify(normalizeRule(b));
}

/** The default tab a rule merely repeats, if any (refused for agents: they filter the default instead). */
export function defaultTabFor(rule: TabRule): DefaultTabId | null {
  for (const id of DEFAULT_TAB_IDS) if (sameRule(rule, DEFAULT_TAB_RULES[id])) return id;
  return null;
}

/** A ticket, PR or subagent's state for rules: the subagent's, else the live status's. */
export function artifactState(item: Artifact): string | null {
  return item.subagent?.state ?? item.status?.state ?? null;
}

export function ruleMatches(rule: TabRule, item: Artifact): boolean {
  if (rule.kind !== undefined && !rule.kind.includes(item.kind)) return false;
  if (rule.media !== undefined && (item.media !== undefined) !== rule.media) return false;
  if (rule.pinned !== undefined && (item.pinned !== undefined) !== rule.pinned) return false;
  if (rule.since !== undefined && item.lastSeen < rule.since) return false;
  if (rule.state !== undefined) {
    const wanted = rule.state.map((s) => s.toLowerCase());
    const state = artifactState(item)?.toLowerCase();
    const type = item.status?.stateType;
    if (!((state !== undefined && wanted.includes(state)) || (type !== undefined && wanted.includes(type)))) return false;
  }
  if (rule.repo !== undefined) {
    const repo = item.repo?.toLowerCase();
    const want = rule.repo.toLowerCase();
    if (repo === undefined || !(repo === want || repo.endsWith(`/${want}`))) return false;
  }
  if (rule.caption !== undefined) {
    const text = `${item.caption ?? ""} ${item.title}`.toLowerCase();
    if (!rule.caption.toLowerCase().split("|").some((part) => part.trim() !== "" && text.includes(part.trim()))) return false;
  }
  return true;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Unpinned items not mentioned for this long leave the tabs (search still finds them). */
export const ARTIFACT_STALE_MS = 7 * DAY_MS;
/** Merged/closed PRs and done/canceled tickets leave the tabs this long after their state changed. */
export const ARTIFACT_DONE_MS = 2 * DAY_MS;

function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** True when an item has faded out of the tabs: pins never fade; finished subagents stay for the day. */
export function artifactFaded(item: Artifact, now: number): boolean {
  if (item.pinned !== undefined) return false;
  const sub = item.subagent;
  if (sub !== undefined) return sub.state !== "running" && !sameLocalDay(sub.endedAt ?? item.lastSeen, now);
  const status = item.status;
  const finished =
    status !== undefined &&
    (status.state === "merged" || status.state === "closed" || status.stateType === "completed" || status.stateType === "canceled");
  if (finished && now - (status.changedAt ?? item.lastSeen) > ARTIFACT_DONE_MS) return true;
  return now - item.lastSeen > ARTIFACT_STALE_MS;
}

/** Pinned first (newest pin first), then running subagents, then most recently seen. */
export function compareArtifacts(a: Artifact, b: Artifact): number {
  const pa = a.pinned?.at ?? -1;
  const pb = b.pinned?.at ?? -1;
  if ((pa >= 0) !== (pb >= 0)) return pa >= 0 ? -1 : 1;
  if (pa !== pb) return pb - pa;
  const ra = a.subagent?.state === "running";
  const rb = b.subagent?.state === "running";
  if (ra !== rb) return ra ? -1 : 1;
  return b.lastSeen - a.lastSeen;
}

/**
 * The rows a tab shows at `now`, in order. A rule tab drops faded items; an item tab shows its
 * items in the order given (explicit picks never fade) with pinned ones first.
 */
export function tabItems(tab: ArtifactTab, items: readonly Artifact[], now: number): Artifact[] {
  if (tab.items !== undefined) {
    const byId = new Map(items.map((item) => [item.id, item]));
    const picked = tab.items.flatMap((id) => {
      const item = byId.get(id);
      return item === undefined ? [] : [item];
    });
    return [...picked.filter((i) => i.pinned !== undefined), ...picked.filter((i) => i.pinned === undefined)];
  }
  const rule = tab.rule ?? {};
  return items.filter((item) => ruleMatches(rule, item) && !artifactFaded(item, now)).sort(compareArtifacts);
}

/** Visible tabs in bar order. */
export function visibleTabs(tabs: readonly ArtifactTab[]): ArtifactTab[] {
  return tabs.filter((tab) => !tab.hidden);
}

/** What a client may do; the host checks who may do it (`by`). */
export const ArtifactAction = z.discriminatedUnion("op", [
  /** Add something no message holds; `tab` also files it under that item tab. Answers `{id}`. */
  z.object({
    op: z.literal("add"),
    kind: ArtifactKind,
    title: z.string().trim().min(1).max(300),
    url: z.string().min(1).max(2048).optional(),
    path: z.string().min(1).max(1024).optional(),
    caption: z.string().max(300).optional(),
    tab: z.string().max(48).optional(),
  }),
  z.object({ op: z.literal("pin"), id: z.string().min(1).max(2100), pinned: z.boolean() }),
  /** Answers `{id}` of the new tab; refused when it repeats a default, a hidden tab, or a visible one. */
  z.object({
    op: z.literal("tab.add"),
    title: z.string().trim().min(1).max(40),
    icon: ArtifactTabIcon.optional(),
    rule: TabRule.optional(),
    items: z.array(z.string().min(1).max(2100)).max(500).optional(),
  }),
  /** Rename, re-rule, refile, move (`index` in the full bar), hide/show (Isaac only), or clear `fresh`. */
  z.object({
    op: z.literal("tab.update"),
    tab: z.string().min(1).max(48),
    title: z.string().trim().min(1).max(40).optional(),
    icon: ArtifactTabIcon.optional(),
    rule: TabRule.optional(),
    items: z.array(z.string().min(1).max(2100)).max(500).optional(),
    index: z.number().int().nonnegative().optional(),
    hidden: z.boolean().optional(),
    fresh: z.literal(false).optional(),
  }),
  /** Agents remove only tabs they made; defaults are never removed (Isaac hides them). */
  z.object({ op: z.literal("tab.remove"), tab: z.string().min(1).max(48) }),
  /** Live states by item id, from Relay desktop's gh and Linear reads. */
  z.object({ op: z.literal("status"), statuses: z.record(z.string().min(1).max(2100), ArtifactStatus) }),
]);
export type ArtifactAction = z.infer<typeof ArtifactAction>;
