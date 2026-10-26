import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Room, RoomAgent, RoomMessage } from '@evaos/contract'
import { authorName } from './prompts'

/**
 * Jev (TypeSafe System One): fast calibrated answers to the two decisions a room makes often,
 * who should speak and whether it has converged. Seats and the summary stay on the LLMs.
 */
export interface Jev {
  /** Probability 0..1 per `speak_<id>` question; the room prompts those at or above 0.5. */
  gate(state: GateState, agents: readonly RoomAgent[]): Promise<Record<string, number>>
  /** `converged` and `circling`, each 0..1. */
  convergence(state: ConvergenceState): Promise<{ converged: number; circling: number }>
}

export interface GateState {
  question: string
  people: { id: string; name: string; role: string; brief: string; tools: string }[]
  transcript: { id: string; author: string; text: string }[]
  /** Messages posted since each agent was last prompted (their own reply included). */
  unseen: Record<string, number>
  /** Who the newest batch addressed by @name (agent ids, or `everyone`). */
  mentioned: string[]
  round: number
}

export interface ConvergenceState {
  question: string
  transcript: { id: string; author: string; text: string }[]
  /** The messages of the round just finished. */
  lastRound: { id: string; author: string; text: string }[]
  round: number
}

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL = 'jev-latest'
/** Jev answers in about 200 ms; past this the room falls back to the model judge. */
export const JEV_TIMEOUT_MS = 8000
/** How much of the thread the gate sees. */
export const RECENT = 12

export const SPEAK_INSTRUCTIONS = (name: string, role: string): string =>
  `Would ${name}, the ${role}, add something the room does not already have if they spoke now? Answer yes only if their angle is missing or they were addressed.`
export const CONVERGED_INSTRUCTIONS =
  'Has the room reached a decision that the people would accept as settled (positions stated, no open disagreement being argued)?'
export const CIRCLING_INSTRUCTIONS = 'Is the last round repeating points already made?'

/** `TYPESAFE_API_KEY` from the environment, else `<evaRoot>/secrets/jev.env`; null when neither has it. */
export function readJevKey(evaRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.TYPESAFE_API_KEY?.trim()
  if (fromEnv) return fromEnv
  try {
    const m = /^TYPESAFE_API_KEY=(.+)$/m.exec(
      fs.readFileSync(path.join(evaRoot, 'secrets', 'jev.env'), 'utf8'),
    )
    return m?.[1]?.trim() || null
  } catch {
    return null
  }
}

const line = (room: Room, m: RoomMessage): { id: string; author: string; text: string } => ({
  id: m.id,
  author: authorName(room, m.author),
  text: m.text,
})

export function gateState(
  room: Room,
  agents: readonly RoomAgent[],
  seen: ReadonlyMap<string, number>,
  mentioned: readonly string[],
): GateState {
  return {
    question: room.prompt,
    people: agents.map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      brief: a.brief,
      tools: a.tools,
    })),
    transcript: room.messages.slice(-RECENT).map((m) => line(room, m)),
    unseen: Object.fromEntries(
      agents.map((a) => [
        a.id,
        room.messages.filter((m) => Number(m.id.slice(1)) > (seen.get(a.id) ?? 0)).length,
      ]),
    ),
    mentioned: [...mentioned],
    round: room.rounds,
  }
}

export function convergenceState(room: Room, lastRound: readonly RoomMessage[]): ConvergenceState {
  return {
    question: room.prompt,
    transcript: room.messages.map((m) => line(room, m)),
    lastRound: lastRound.map((m) => line(room, m)),
    round: room.rounds,
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const noul = (answers: unknown, q: string): number => {
  const a = isObj(answers) ? answers[q] : undefined
  const n = isObj(a) ? a.noul : undefined
  if (typeof n !== 'number' || Number.isNaN(n)) throw new Error(`jev: no noul for ${q}`)
  return n
}

/** The HTTP client; the key never leaves the Authorization header. */
export class JevClient implements Jev {
  constructor(
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async ask(state: unknown, questions: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchImpl(JEV_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
    })
    if (!res.ok) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const body: unknown = await res.json()
    return isObj(body) ? body.answers : undefined
  }

  async gate(state: GateState, agents: readonly RoomAgent[]): Promise<Record<string, number>> {
    const questions = Object.fromEntries(
      agents.map((a) => [
        `speak_${a.id}`,
        { type: 'noul', instructions: SPEAK_INSTRUCTIONS(a.name, a.role) },
      ]),
    )
    const answers = await this.ask(state, questions)
    return Object.fromEntries(agents.map((a) => [a.id, noul(answers, `speak_${a.id}`)]))
  }

  async convergence(state: ConvergenceState): Promise<{ converged: number; circling: number }> {
    const answers = await this.ask(state, {
      converged: { type: 'noul', instructions: CONVERGED_INSTRUCTIONS },
      circling: { type: 'noul', instructions: CIRCLING_INSTRUCTIONS },
    })
    return { converged: noul(answers, 'converged'), circling: noul(answers, 'circling') }
  }
}
