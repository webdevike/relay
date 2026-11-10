// The Agents board (`agents.board`, `agents.changed`): main reads the ledgers, every assistant's
// auto-work state and registered sessions, the host's activity list, PR facts and Linear states,
// and derive.ts places the cards. Slow facts come from background caches; a change in any source
// pushes `agents.changed` so an open board refreshes.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { watchTrees, type TreeWatch } from '../tree-watch'
import { z } from 'zod'
import type { ActivityItem } from '@evaos/chat-core/activity'
import { sessionId } from '@evaos/chat-core/session-id'
import type { Assistant } from '@evaos/contract'
import type { ChatHandles } from '../chat'
import type { MainContext } from '../context'
import { clockFor } from '../eva/runtime'
import { emit, handle } from '../ipc/handle'
import { relayConfigDir } from '../relay/device'
import { ItemReader } from '../context-popover/items'
import type { PrSource } from '../context-popover/pr-source'
import {
  assistantNotes,
  assistantSessions,
  hostThreadFile,
  LineCache,
  sessionTitle,
  subagentsOf,
} from '../context-popover/sessions'
import { itemOwners } from '../context-popover/snapshot'
import { buildBoard, linearKeys, type AutoWork, type Run } from './derive'
import type { LinearStates } from './linear-states'

/** File and source bursts become one `agents.changed`. */
const CHANGED_DEBOUNCE_MS = 400
/** Registered sessions per assistant the board reads (open ones always; closed ones newest first). */
const SESSIONS_PER_AGENT = 40

const AutoWorkJson = z.object({
  tickets: z
    .record(
      z.string(),
      z.object({
        phase: z.string(),
        phaseAt: z.string().optional(),
        pr: z.string().optional(),
        bouncedAt: z.string().optional(),
        bounceNote: z.string().optional(),
      }),
    )
    .optional(),
  started: z
    .record(
      z.string(),
      z.object({
        title: z.string().optional(),
        url: z.string().optional(),
        at: z.string().optional(),
        phase: z.string().optional(),
        state: z.string().optional(),
        sessionFile: z.string().optional(),
        endedAt: z.string().optional(),
        escalatedAt: z.string().optional(),
        note: z.string().optional(),
      }),
    )
    .optional(),
  flagged: z.array(z.string()).optional(),
})

/** An assistant's auto-work.json, parsed again only when the file changed. */
class AutoWorkReader {
  private readonly seen = new Map<
    string,
    { mtimeMs: number; data: z.infer<typeof AutoWorkJson> | null }
  >()

  constructor(private readonly evaRoot: string) {}

  read(agentId: string, agentTitle: string): AutoWork | null {
    const file = path.join(this.evaRoot, 'work/eva/agents', agentId, 'auto-work.json')
    let st: fs.Stats
    try {
      st = fs.statSync(file)
    } catch {
      this.seen.delete(file)
      return null
    }
    let hit = this.seen.get(file)
    if (!hit || hit.mtimeMs !== st.mtimeMs) {
      let data: z.infer<typeof AutoWorkJson> | null = null
      try {
        const parsed = AutoWorkJson.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')))
        data = parsed.success ? parsed.data : null
      } catch {
        data = null
      }
      hit = { mtimeMs: st.mtimeMs, data }
      this.seen.set(file, hit)
    }
    if (!hit.data) return null
    return {
      agent: agentTitle,
      tickets: hit.data.tickets ?? {},
      started: hit.data.started ?? {},
      flagged: hit.data.flagged ?? [],
    }
  }
}

function activityRun(item: ActivityItem, ownerName: (owner: string) => string | null): Run {
  const open = item.open
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    status: item.status,
    intent: item.intent || null,
    agent: ownerName(item.owner),
    at: item.updatedAt,
    session: open.to === 'chat' ? (open.session ?? null) : null,
    open: { kind: 'activity', item },
  }
}

export function registerAgentsBoard(
  ctx: MainContext,
  chat: Pick<
    ChatHandles,
    'onSessionsChanged' | 'assistants' | 'relaySessions' | 'sessionFile' | 'activity'
  >,
  prs: PrSource,
  linear: LinearStates,
): void {
  const evaRoot = ctx.env.evaRoot
  const clock = clockFor(ctx)
  const hostDir = prs.allowed
    ? (ctx.env.relayDir ?? relayConfigDir(process.env, os.homedir()))
    : null
  const items = new ItemReader(evaRoot)
  const autoWork = new AutoWorkReader(evaRoot)
  const lines = new LineCache()

  let timer: NodeJS.Timeout | undefined
  const changed = (): void => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      emit(ctx, 'agents.changed', {})
    }, CHANGED_DEBOUNCE_MS)
  }

  // Ledgers and the assistants' state files: watched once the board was first asked for.
  let files: TreeWatch | null = null
  const watchFiles = (): void => {
    files ??= watchTrees(
      [path.join(evaRoot, 'work/items'), path.join(evaRoot, 'work/eva/agents')],
      changed,
      {
        depth: 1,
        ignored: (p: string) =>
          /(^|\/)\.[^/]*\.tmp$/.test(p) || /\.(png|jpe?g|webm|mp4|log)$/i.test(p),
        label: 'agents-board',
      },
    )
  }

  handle(ctx, 'agents.board', () => {
    watchFiles()
    const now = clock.now().getTime()
    // Without a Relay link (Relay Dev) the host's own record still names each thread.
    const agents: Assistant[] = chat
      .assistants()
      .agents.map((a) =>
        a.file !== null || hostDir === null ? a : { ...a, file: hostThreadFile(hostDir, a.id) },
      )
    const titleOf = new Map(agents.map((a) => [a.id, a.title]))
    const relay = chat.relaySessions()
    const ownerName = (owner: string): string | null => {
      if (owner.startsWith('assistant:')) {
        const id = owner.slice('assistant:'.length)
        return titleOf.get(id) ?? id
      }
      if (!owner.startsWith('session:')) return null
      const id = owner.slice('session:'.length)
      const s = relay?.get(id)
      if (s?.title) return s.title
      const file = chat.sessionFile(id)
      return file ? sessionTitle(file) : null
    }

    // Runs: the host's activity list, then what the assistants' own files say (sessions they
    // registered, their threads' subagents) for anything the host does not list or lists as over.
    const rank = (r: Run): number =>
      r.status === 'waiting' ? 4 : r.status === 'working' ? 3 : r.status === 'open' ? 2 : 1
    const runs = new Map<string, Run>()
    for (const item of chat.activity.activity()) runs.set(item.id, activityRun(item, ownerName))
    for (const a of agents) {
      const workers = [
        ...(a.file ? subagentsOf(a.file, now, lines) : []),
        ...assistantSessions(evaRoot, a.id, now, lines, SESSIONS_PER_AGENT),
      ]
      for (const w of workers) {
        const own = w.session === w.file
        const run: Run = {
          id: own ? `session:${sessionId(w.file)}` : `helper:${w.file}`,
          kind: own ? 'session' : 'helper',
          title: w.name,
          status: w.running ? 'working' : w.closed === false ? 'open' : 'done',
          intent: w.line || null,
          agent: a.title,
          at: w.at,
          session: own ? sessionId(w.file) : null,
          open: own
            ? { kind: 'chat', file: w.file }
            : { kind: 'subagent', session: w.session, file: w.file, name: w.name },
        }
        const seen = runs.get(run.id)
        if (!seen || rank(run) > rank(seen)) runs.set(run.id, run)
      }
    }

    const all = items.all()
    const notes = agents.map((a) => ({
      id: a.id,
      scope: a.scope,
      notes: assistantNotes(evaRoot, a.id),
    }))
    const owners = new Map(
      [...itemOwners(all, notes)].map(([key, id]) => [key, titleOf.get(id) ?? id] as const),
    )
    const auto = agents
      .map((a) => autoWork.read(a.id, a.title))
      .filter((w): w is AutoWork => w !== null)

    const cards = buildBoard({
      now,
      items: all,
      autoWork: auto,
      runs: [...runs.values()],
      owners,
      pr: (repo, number) => prs.get(repo, number, false),
      linear: (key) => linear.get(key),
      linearStarted: linear.started(),
    })
    linear.want(linearKeys(cards))
    return {
      cards,
      sources: {
        items: all.length,
        autoWork: auto.length > 0,
        activity: relay !== null,
        linear: linear.status(),
      },
      updatedAt: now,
    }
  })

  const offs = [
    chat.onSessionsChanged(changed),
    chat.activity.onActivity(changed),
    prs.onChange(changed),
    linear.onChange(changed),
  ]
  ctx.onBeforeQuit(async () => {
    for (const off of offs) off()
    clearTimeout(timer)
    files?.close()
  })
}
