// In remote mode (`relayRemote`) omp runs only on the Mini: starting a chat, the composer's model
// and command lists, and plan usage are asked of the Mini's Relay Host instead of a local omp.
import type { ModelInfo, Profile, SlashCommand } from '@evaos/chat-core/launch'
import { UsageSnapshotSchema, type UsageSnapshot } from '@evaos/contract'
import { NO_ANSWER, NOT_CONNECTED, RelayCommandError, type RelayFrames } from './client'
import { cmdFrame } from './commands'
import type { RelaySession } from './feed'

/** The host waits up to a minute for a launched omp to join; this covers that and the ack. */
export const START_TIMEOUT_MS = 90_000
export const ASK_TIMEOUT_MS = 20_000
export const NO_MINI_CHAT =
  'No chat is running on the Mini to list its models and commands. Start one there first.'

export interface Mini {
  /** Starts omp on the Mini (or reopens session `resume`) and resolves its session id once it joins. */
  start(o: { resume?: string; profile: Profile | null; thinking?: string }): Promise<string>
  /** Models and slash commands as a running Mini chat offers them. */
  options(): Promise<{ models: ModelInfo[]; commands: SlashCommand[] }>
  /** The models the last `options()` returned, or null. */
  peekModels(): ModelInfo[] | null
  /** Plan usage of every omp account on the Mini. */
  usage(): Promise<UsageSnapshot>
}

type Frame = Record<string, unknown>

/** Sends `frame` and settles on the first frame `answer` returns a value for (or throws on). */
function ask<T>(
  frames: RelayFrames,
  frame: Frame,
  answer: (f: Frame) => T | undefined,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const done = (err: unknown, value?: T): void => {
      clearTimeout(timer)
      off()
      if (err) reject(err)
      else resolve(value as T)
    }
    const timer = setTimeout(() => done(new RelayCommandError('timeout', NO_ANSWER)), timeoutMs)
    const off = frames.onFrame((f) => {
      try {
        const v = answer(f)
        if (v !== undefined) done(null, v)
      } catch (e) {
        done(e)
      }
    })
    if (!frames.sendFrame(frame)) done(new RelayCommandError('not_connected', NOT_CONNECTED))
  })
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const list = (v: unknown): Frame[] =>
  Array.isArray(v) ? v.filter((x): x is Frame => typeof x === 'object' && x !== null) : []

/** A wheel entry (protocol `AgentSkill`) as the composer's `/` menu has it. */
function slashCommand(s: Frame, word: number): SlashCommand | null {
  const name = str(s.command)?.slice(1).split(' ')[word]
  if (!name) return null
  return {
    name,
    description: str(s.description) ?? '',
    hint: str(s.hint),
    subcommands: list(s.choices)
      .map((c) => slashCommand(c, 1))
      .filter((c): c is SlashCommand => c !== null),
  }
}

export function createMini(
  frames: RelayFrames,
  sessions: () => ReadonlyMap<string, RelaySession> | null,
  now: () => number = Date.now,
): Mini {
  let seq = 0
  let models: ModelInfo[] | null = null
  return {
    start: ({ resume, profile, thinking }) => {
      seq += 1
      const id = `relay-desktop-start-${now()}-${seq}`
      const cmd = { kind: 'agent.start' as const, resume, thinkingLevel: thinking }
      return ask(
        frames,
        cmdFrame(id, profile !== null ? { ...cmd, profile } : cmd),
        (f) => {
          if (f.id !== id) return undefined
          if (f.t === 'nack') {
            const e = (f.error ?? {}) as Frame
            throw new RelayCommandError(str(e.code) ?? 'internal', str(e.message) || 'Refused.')
          }
          return f.t === 'agent.started' ? (str(f.sessionId) ?? undefined) : undefined
        },
        START_TIMEOUT_MS,
      )
    },
    options: async () => {
      const live = [...(sessions()?.values() ?? [])].find(
        (s) => s.status !== 'ended' && s.canRespond,
      )
      if (!live) throw new Error(NO_MINI_CHAT)
      const f = await ask(
        frames,
        { t: 'agent.options', sessionId: live.id },
        (f) => (f.t === 'agent.options' && f.sessionId === live.id ? f : undefined),
        ASK_TIMEOUT_MS,
      )
      models = list(f.models).flatMap((m) => {
        const provider = str(m.provider)
        const id = str(m.id)
        if (provider === null || id === null) return []
        const raw: unknown[] = Array.isArray(m.thinkingLevels) ? m.thinkingLevels : []
        const levels = raw.filter((l): l is string => typeof l === 'string')
        return [
          {
            provider,
            id,
            name: str(m.name) ?? id,
            contextWindow:
              typeof m.contextWindow === 'number' && m.contextWindow > 0 ? m.contextWindow : null,
            images: true,
            levels,
          },
        ]
      })
      const commands = list(f.skills)
        .map((s) => slashCommand(s, 0))
        .filter((c): c is SlashCommand => c !== null && c.name !== 'goal')
      return { models, commands }
    },
    peekModels: () => models,
    usage: () =>
      ask(
        frames,
        { t: 'usage.get' },
        (f) => {
          if (f.t !== 'usage.snapshot') return undefined
          const parsed = UsageSnapshotSchema.safeParse(f.usage)
          return parsed.success ? parsed.data : undefined
        },
        ASK_TIMEOUT_MS,
      ),
  }
}
