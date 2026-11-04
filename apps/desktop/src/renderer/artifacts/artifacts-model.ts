// What the Artifacts panel draws, as pure functions over the host's items and tabs: which thread a
// panel scope shows, row text and status pills, link groups, the subagent tree, media tiles,
// rule chips and where a click goes. The tabs' contents come from chat-core's `tabItems`, the
// same rule the phone uses.
import {
  ARTIFACT_KINDS,
  SUBAGENT_STALE_MS,
  subagentView,
  type SubagentState,
  type Artifact,
  type ArtifactKind,
  type ArtifactTab,
  type TabRule,
} from '@evaos/chat-core/artifacts'

/** The `artifacts.watch` input for a panel scope: an assistant page or a chat; null for any other page. */
export function watchTarget(scope: string): { file: string; agent: string | null } | null {
  const agent = /^page:agent:([a-z][a-z0-9-]*)$/.exec(scope)?.[1]
  if (agent !== undefined) return { file: '', agent }
  if (scope.startsWith('chat:') && scope.length > 'chat:'.length) {
    return { file: scope.slice('chat:'.length), agent: null }
  }
  return null
}

export const KIND_LABEL: Readonly<Record<ArtifactKind, string>> = {
  linear: 'Linear ticket',
  'gh-pr': 'GitHub PR',
  'gh-issue': 'GitHub issue',
  url: 'web link',
  drop: 'drop',
  image: 'pasted image',
  file: 'file',
  experiment: 'Test Bench run',
  canvas: 'canvas',
  branch: 'branch',
  subagent: 'subagent',
}

/** The short key a row leads with: `ENG-6528`, `#238` (its repo goes in the meta line); null for kinds without one. */
export function itemKey(item: Artifact): string | null {
  if (item.kind === 'linear') return item.id.slice('linear:'.length)
  if (item.kind === 'gh-pr' || item.kind === 'gh-issue') {
    const m = /#(\d+)$/.exec(item.id)
    return m ? `#${m[1]}` : null
  }
  return null
}

/** A PR's, issue's or branch's repo by name (`react-client-reports-app`), for the meta line. */
export function repoName(item: Artifact): string | null {
  const repo = item.repo ?? /^gh-(?:pr|issue):([^\s#]+\/[^\s#]+)#\d+$/.exec(item.id)?.[1]
  return repo === undefined ? null : (repo.split('/').pop() ?? repo)
}

/** The row's title, or empty when the host has not named it yet (it is just its key or id). */
export function itemTitle(item: Artifact): string {
  const key = itemKey(item)
  const t = item.title.trim()
  if (t === item.id || t === key) return ''
  return key !== null && t.endsWith(key) && t.length - key.length < 120 && !/\s/.test(t) ? '' : t
}

type LinkKind = 'linear' | 'github' | 'web'

/** Which Links group an item falls under. */
function linkKind(item: Artifact): LinkKind {
  if (item.kind === 'linear') return 'linear'
  if (item.kind === 'gh-pr' || item.kind === 'gh-issue' || item.kind === 'branch') return 'github'
  return 'web'
}

/** Items matching every word of `query` in title, key, caption, url or path; empty query: all. */
export function searchItems(items: readonly Artifact[], query: string): Artifact[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...items]
  return items.filter((item) => {
    const text =
      `${item.title} ${item.id} ${item.caption ?? ''} ${item.url ?? ''} ${item.path ?? ''}`.toLowerCase()
    return words.every((w) => text.includes(w))
  })
}

export interface RowGroup {
  key: string
  label: string
  rows: Artifact[]
}

const LINK_GROUPS: ReadonlyArray<{ key: LinkKind; label: string }> = [
  { key: 'linear', label: 'Linear' },
  { key: 'github', label: 'GitHub' },
  { key: 'web', label: 'Web' },
]

/** The Links tab's sections: pinned on top, then Linear, GitHub and Web, each in the order given. */
export function linkGroups(rows: readonly Artifact[]): RowGroup[] {
  const pinned = rows.filter((r) => r.pinned !== undefined)
  const groups: RowGroup[] =
    pinned.length > 0 ? [{ key: 'pinned', label: 'Pinned', rows: pinned }] : []
  for (const g of LINK_GROUPS) {
    const inGroup = rows.filter((r) => r.pinned === undefined && linkKind(r) === g.key)
    if (inGroup.length > 0) groups.push({ key: g.key, label: g.label, rows: inGroup })
  }
  return groups
}

/** `9:47 PM` today, `Oct 3` this year, else `Oct 3, 2025`. */
export function whenText(at: number, now: number): string {
  const d = new Date(at)
  const n = new Date(now)
  if (d.toDateString() === n.toDateString()) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === n.getFullYear() ? {} : { year: 'numeric' }),
  })
}

/** `mentioned 82x, last 9:47 PM`, or `last 9:47 PM` for an item mentioned once. */
export function seenText(item: Artifact, now: number): string {
  const last = `last ${whenText(item.lastSeen, now)}`
  return item.mentions > 1 ? `mentioned ${item.mentions}x, ${last}` : last
}

/** A person's name in the panel: Isaac is `you`; an agent its registry name, else its id. */
export function actorName(by: string, title: (id: string) => string | null): string {
  if (by === 'isaac') return 'you'
  return title(by) ?? by
}

export type Tone = 'gray' | 'blue' | 'yellow' | 'orange' | 'green' | 'red' | 'violet'

export interface Pill {
  label: string
  tone: Tone
}

const capital = (s: string): string => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase())

/** A Linear state as its pill: the state's name, colored by its category (review violet, QA blue). */
export function linearPill(state: string, stateType: string | undefined): Pill {
  const label = capital(state)
  if (/review/i.test(state)) return { label, tone: 'violet' }
  if (/\bqa\b/i.test(state)) return { label, tone: 'blue' }
  const tone: Tone =
    stateType === 'completed'
      ? 'green'
      : stateType === 'started'
        ? 'yellow'
        : stateType === 'triage'
          ? 'orange'
          : 'gray'
  return { label, tone }
}

/** The pills on a row's right: a ticket's state, a PR's state and review, then its checks. */
export function statusPills(item: Artifact): Pill[] {
  const s = item.status
  if (s === undefined) return []
  if (item.kind === 'linear') return [linearPill(s.state, s.stateType)]
  if (item.kind !== 'gh-pr' && item.kind !== 'gh-issue') return []
  const pills: Pill[] = []
  if (s.state === 'merged') pills.push({ label: 'Merged', tone: 'violet' })
  else if (s.state === 'closed') pills.push({ label: 'Closed', tone: 'gray' })
  else if (s.draft) pills.push({ label: 'Draft', tone: 'gray' })
  else if (s.review === 'changes') pills.push({ label: 'Changes requested', tone: 'orange' })
  else if (s.review === 'required') pills.push({ label: 'Review required', tone: 'blue' })
  else if (s.review === 'approved') pills.push({ label: 'Approved', tone: 'green' })
  else if (item.kind === 'gh-issue' && s.state === 'open')
    pills.push({ label: 'Open', tone: 'green' })
  if (item.kind === 'gh-pr' && s.state === 'open') {
    if (s.checks === 'fail') pills.push({ label: 'Checks failing', tone: 'red' })
    else if (s.checks === 'pending') pills.push({ label: 'Checks running', tone: 'gray' })
    else if (s.checks === 'pass') pills.push({ label: 'Checks pass', tone: 'green' })
  }
  return pills
}

/** A PR's linked ticket as its meta shows it: `ENG-6525 In Progress`, or just the key. */
export function linkedText(item: Artifact, byId: ReadonlyMap<string, Artifact>): string | null {
  const key = item.status?.linked
  if (key === undefined) return null
  const ticket = byId.get(`linear:${key}`)?.status
  return ticket ? `${key} ${capital(ticket.state)}` : key
}

/** Where a GitHub PR or issue lives on the web, from its url or its id. */
export function externalUrl(item: Artifact): string | null {
  if (item.url !== undefined && /^https?:\/\//.test(item.url)) return item.url
  const m = /^gh-(pr|issue):([^\s#]+\/[^\s#]+)#(\d+)$/.exec(item.id)
  if (m) return `https://github.com/${m[2]}/${m[1] === 'pr' ? 'pull' : 'issues'}/${m[3]}`
  if (item.kind === 'branch' && item.repo !== undefined) {
    return `https://github.com/${item.repo}/tree/${encodeURIComponent(item.title)}`
  }
  return null
}

/** What clicking a row does. */
export type OpenTarget =
  | { to: 'browser'; url: string }
  | { to: 'files'; path: string }
  | { to: 'testbench'; experiment: string }
  | { to: 'canvas'; slug: string }
  | { to: 'subagent'; file: string; name: string }
  | { to: 'lightbox' }

export function openTarget(item: Artifact): OpenTarget | null {
  switch (item.kind) {
    case 'drop':
    case 'image':
      return { to: 'lightbox' }
    case 'file':
      if (item.media !== undefined) return { to: 'lightbox' }
      return item.path === undefined ? null : { to: 'files', path: item.path }
    case 'experiment': {
      const dir = item.id.slice('experiment:'.length)
      return dir === '' ? null : { to: 'testbench', experiment: dir }
    }
    case 'canvas': {
      const slug = item.id.slice('canvas:'.length)
      return slug === '' ? null : { to: 'canvas', slug }
    }
    case 'subagent': {
      const file = item.path ?? item.id.slice('subagent:'.length)
      return file === '' ? null : { to: 'subagent', file, name: item.title }
    }
    default: {
      const url = externalUrl(item)
      return url === null ? null : { to: 'browser', url }
    }
  }
}

export interface TreeRow {
  item: Artifact
  depth: number
}

/** The transcript facts of one subagent of the open chat, as main reads them from its folder. */
export interface TranscriptFact {
  name: string
  /** Its transcript's file name inside the session's folder. */
  file: string
  done: boolean
  failed: boolean
  mtimeMs: number
  lastLine: string
}

/**
 * A subagent transcript's identity across machines: its folder (the session's name) and its file.
 * The host lists the path as it is on its own disk and a thin client reads a mirror under another
 * root, so the full paths differ for one subagent; these two segments do not.
 */
export const subagentKey = (p: string): string => p.split('/').slice(-2).join('/')

/** Whether `a` is the better row for one subagent than `b`: running beats finished, then the newer. */
const fresher = (a: Artifact, b: Artifact): boolean => {
  const aRun = a.subagent?.state === 'running'
  const bRun = b.subagent?.state === 'running'
  return aRun !== bRun ? aRun : a.lastSeen >= b.lastSeen
}

/** One row per subagent: the same transcript listed under two paths (host and mirror) shows once. */
function onePerSubagent(items: readonly Artifact[]): Artifact[] {
  const best = new Map<string, Artifact>()
  for (const item of items) {
    if (item.subagent === undefined || item.path === undefined) continue
    const key = subagentKey(item.path)
    const have = best.get(key)
    if (
      have === undefined ||
      (fresher(item, have) && !(item.pinned === undefined && have.pinned !== undefined))
    ) {
      best.set(key, item)
    }
  }
  return items.filter(
    (item) =>
      item.subagent === undefined ||
      item.path === undefined ||
      best.get(subagentKey(item.path)) === item,
  )
}

/**
 * The open chat's subagents as the host's items plus what the transcripts on disk say (the same
 * facts the context button's dot reads). The files win on state: a transcript with its `.md` is
 * done whatever the host still says, and one written within SUBAGENT_STALE_MS without it is
 * running even before the host has listed it, so the dot and this list agree about it. One that
 * finished today is listed even when the host never did (or Tidy hid it), and a finished row's
 * line is its outcome, not the progress note it ended on.
 */
export function withTranscripts(
  items: readonly Artifact[],
  session: string,
  facts: readonly TranscriptFact[],
  now: number,
): Artifact[] {
  const unique = onePerSubagent(items)
  const dir = session.replace(/\.jsonl$/, '')
  if (dir === session || facts.length === 0) return unique
  const byPath = new Map(facts.map((f) => [subagentKey(`${dir}/${f.file}`), f]))
  const seen = new Set<string>()
  const today = new Date(now).toDateString()
  const out = unique.map((item): Artifact => {
    const fact = item.path !== undefined ? byPath.get(subagentKey(item.path)) : undefined
    if (fact === undefined || item.subagent === undefined) return item
    seen.add(subagentKey(item.path!))
    const state: SubagentState = fact.done
      ? fact.failed
        ? 'failed'
        : 'done'
      : now - fact.mtimeMs > SUBAGENT_STALE_MS
        ? 'done'
        : 'running'
    // A helper woken after it finished is running again: its old outcome is not its line now.
    const resumed = state === 'running' && item.subagent.state !== 'running'
    const line =
      (state !== 'running' || resumed) && fact.lastLine !== ''
        ? fact.lastLine.slice(0, 200)
        : undefined
    if (state === item.subagent.state && (line === undefined || line === item.subagent.line)) {
      return item
    }
    const { endedAt, ...running } = item.subagent
    return {
      ...item,
      lastSeen: Math.max(item.lastSeen, fact.mtimeMs),
      subagent:
        state === 'running'
          ? { ...running, state, ...(line !== undefined ? { line } : {}) }
          : {
              ...running,
              state,
              ...(line !== undefined ? { line } : {}),
              endedAt: endedAt ?? fact.mtimeMs,
            },
    }
  })
  for (const [key, fact] of byPath) {
    if (seen.has(key)) continue
    const path = `${dir}/${fact.file}`
    const running = !fact.done && now - fact.mtimeMs <= SUBAGENT_STALE_MS
    // An abandoned transcript (no `.md`, quiet for 30 minutes) is not a finished subagent.
    if (!running && !fact.done) continue
    if (!running && new Date(fact.mtimeMs).toDateString() !== today) continue
    out.push({
      id: `subagent:${path}`,
      kind: 'subagent',
      title: fact.name,
      path,
      mentions: 0,
      firstSeen: fact.mtimeMs,
      lastSeen: fact.mtimeMs,
      sources: [],
      addedBy: 'extractor',
      subagent: {
        state: running ? 'running' : fact.failed ? 'failed' : 'done',
        startedAt: fact.mtimeMs,
        ...(running ? {} : { endedAt: fact.mtimeMs }),
        ...(fact.lastLine !== '' ? { line: fact.lastLine.slice(0, 200) } : {}),
      },
    })
  }
  return out
}

/**
 * The Subagents tab: running ones first (a running child lifts its parent), children nested
 * under their parent; returns the running section and the finished one.
 */
export function subagentTree(
  rows: readonly Artifact[],
  now: number,
): {
  running: TreeRow[]
  finished: TreeRow[]
} {
  const ids = new Set(rows.map((r) => r.id))
  const children = new Map<string, Artifact[]>()
  const roots: Artifact[] = []
  for (const r of rows) {
    const parent = r.subagent?.parent
    if (parent !== undefined && ids.has(parent) && parent !== r.id) {
      children.set(parent, [...(children.get(parent) ?? []), r])
    } else roots.push(r)
  }
  const live = (r: Artifact, seen: Set<string>): boolean =>
    subagentView(r, now) === 'running' ||
    (children.get(r.id) ?? []).some((c) => !seen.has(c.id) && live(c, new Set([...seen, c.id])))
  const walk = (r: Artifact, depth: number, out: TreeRow[], seen: Set<string>): void => {
    out.push({ item: r, depth })
    for (const c of children.get(r.id) ?? []) {
      if (!seen.has(c.id)) walk(c, depth + 1, out, new Set([...seen, c.id]))
    }
  }
  const running: TreeRow[] = []
  const finished: TreeRow[] = []
  for (const r of roots) walk(r, 0, live(r, new Set([r.id])) ? running : finished, new Set([r.id]))
  return { running, finished }
}

/** Whether any of the rows the Subagents tab lists is running: the tab's spinner reads this. */
export const anyRunning = (rows: readonly Artifact[], now: number): boolean =>
  rows.some((i) => subagentView(i, now) === 'running')

export const isVideo = (item: Artifact): boolean =>
  item.media?.mimeType.startsWith('video/') === true

/** The Media tab's tiles, pinned first, then newest first. */
export function mediaTiles(rows: readonly Artifact[]): Artifact[] {
  return [...rows].sort((a, b) => {
    const pa = a.pinned !== undefined
    if (pa !== (b.pinned !== undefined)) return pa ? -1 : 1
    return b.lastSeen - a.lastSeen
  })
}

/** `0:11`, `12:04`, `1:02:03`. */
export function durationText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** How long something has run: `4m`, `52m`, `1h 10m`. */
export function ageText(since: number, now: number): string {
  const min = Math.max(0, Math.floor((now - since) / 60_000))
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  return min % 60 === 0 ? `${h}h` : `${h}h ${min % 60}m`
}

/** Where the panel loads an item's picture from: its host path or file, through relay-media. */
export function mediaSource(item: Artifact): string | null {
  if (item.url !== undefined && (item.url.startsWith('/') || /^https?:\/\//.test(item.url)))
    return item.url
  if (item.kind === 'file' && item.path !== undefined) return item.path
  return null
}

/** A rule read out as chips: `kind is GitHub PR`, `state is open`, `caption has before or after`. */
export function ruleChips(rule: TabRule): string[] {
  const chips: string[] = []
  if (rule.kind !== undefined)
    chips.push(`kind is ${rule.kind.map((k) => KIND_LABEL[k]).join(' or ')}`)
  if (rule.state !== undefined) chips.push(`state is ${rule.state.join(' or ')}`)
  if (rule.media !== undefined) chips.push(rule.media ? 'image or video' : 'not media')
  if (rule.caption !== undefined) {
    chips.push(
      `caption has ${rule.caption
        .split('|')
        .map((p) => p.trim())
        .filter(Boolean)
        .join(' or ')}`,
    )
  }
  if (rule.repo !== undefined) chips.push(`repo is ${rule.repo}`)
  if (rule.pinned !== undefined) chips.push(rule.pinned ? 'pinned' : 'not pinned')
  if (rule.since !== undefined) {
    chips.push(
      `seen since ${new Date(rule.since).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
    )
  }
  return chips
}

/** A tab's footer line: who made it and what fills it. */
export function tabOrigin(tab: ArtifactTab, maker: string, now: number): string {
  const by = tab.createdBy === 'default' ? 'Built in' : `Made by ${maker === 'you' ? 'you' : maker}`
  const at = tab.createdBy === 'default' ? '' : ` at ${whenText(tab.createdAt, now)}`
  const fill =
    tab.items !== undefined
      ? `, a list of ${tab.items.length} kept by hand`
      : tab.rule !== undefined && Object.keys(tab.rule).length > 0
        ? ', updates as items match its rule'
        : ', everything the thread holds'
  return `${by}${at}${fill}`
}

/** The rule editor's draft: comma lists the host gets as a rule; an empty draft is no rule. */
export interface RuleDraft {
  kinds: ArtifactKind[]
  states: string
  caption: string
  repo: string
  media: 'any' | 'yes' | 'no'
  pinned: 'any' | 'yes' | 'no'
}

export function draftOf(rule: TabRule | undefined): RuleDraft {
  return {
    kinds: [...(rule?.kind ?? [])],
    states: (rule?.state ?? []).join(', '),
    caption: rule?.caption ?? '',
    repo: rule?.repo ?? '',
    media: rule?.media === undefined ? 'any' : rule.media ? 'yes' : 'no',
    pinned: rule?.pinned === undefined ? 'any' : rule.pinned ? 'yes' : 'no',
  }
}

export function ruleOf(draft: RuleDraft, since?: number): TabRule {
  const rule: TabRule = {}
  const kinds = draft.kinds.filter((k) => (ARTIFACT_KINDS as readonly string[]).includes(k))
  if (kinds.length > 0) rule.kind = kinds
  const states = draft.states
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12)
  if (states.length > 0) rule.state = states
  if (draft.caption.trim() !== '') rule.caption = draft.caption.trim().slice(0, 120)
  if (draft.repo.trim() !== '') rule.repo = draft.repo.trim().slice(0, 200)
  if (draft.media !== 'any') rule.media = draft.media === 'yes'
  if (draft.pinned !== 'any') rule.pinned = draft.pinned === 'yes'
  if (since !== undefined) rule.since = since
  return rule
}

/** The new bar index of a tab moved one step (`-1` left, `1` right), or null at an end. */
export function movedIndex(tabs: readonly ArtifactTab[], id: string, step: -1 | 1): number | null {
  const at = tabs.findIndex((t) => t.id === id)
  const to = at + step
  return at < 0 || to < 0 || to >= tabs.length ? null : to
}
