import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { z } from 'zod'

/** An assistant `@computer` can answer as. */
export interface ComputerAssistant {
  id: string
  title: string
  profile: string
}

export interface RouteDecision {
  assistant: ComputerAssistant
  /** The task with an addressed name removed. */
  task: string
  reason: string
}

const RegistrySchema = z.object({
  agents: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      profile: z.string().optional().catch(undefined),
    }),
  ),
})

/** The assistants registry (`<Eva>/.omp/assistant/agents.json`); Nova and Astra when unreadable. */
export function loadAssistants(evaRoot: string): ComputerAssistant[] {
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(evaRoot, '.omp/assistant/agents.json'), 'utf8'),
    )
    const agents = RegistrySchema.parse(raw).agents.map((a) => ({
      id: a.id,
      title: a.title,
      profile: a.profile ?? '',
    }))
    if (agents.length > 0) return agents
  } catch {
    // fall through to the two defaults
  }
  return [
    { id: 'nova', title: 'Nova', profile: 'personal' },
    { id: 'astra', title: 'Astra', profile: 'work' },
  ]
}

/** eCard's repo names, as Relay Assist caches them once a day (`gh repo list eCardSystems`). */
export function loadEcardRepos(
  file = path.join(os.homedir(), 'Library/Caches/RelayBuddy/ecard-repos.txt'),
): string[] {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l.includes('-'))
  } catch {
    return []
  }
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** "Astra, ...", "hey Nova ...", "..., Nova?" or "ask Astra ...": that assistant and the task without the name (Assist's `addressed`). */
export function addressed(
  task: string,
  agents: readonly ComputerAssistant[],
): { assistant: ComputerAssistant; task: string } | null {
  for (const assistant of agents) {
    const name = escape(assistant.title)
    const patterns = [
      new RegExp(`^\\s*(?:(?:hey|hi|ok|okay|ask)\\s+)?${name}\\b[\\s,:;!.]*`, 'i'),
      new RegExp(`[\\s,]+${name}(?=[\\s?.!]*$)`, 'i'),
      new RegExp(`\\b(?:hey|ask)\\s+${name}\\b[\\s,:]*`, 'i'),
      new RegExp(`\\b${name},\\s*`, 'i'),
    ]
    for (const re of patterns) {
      const m = re.exec(task)
      if (!m) continue
      const stripped = (
        task.slice(0, m.index) +
        (m.index === 0 ? '' : ' ') +
        task.slice(m.index + m[0].length)
      )
        .trim()
        .replace(/\s+([?.!])/g, '$1')
      return { assistant, task: stripped === '' ? task : stripped }
    }
  }
  return null
}

/** Why the task is eCard work (Assist's `ecardQuestion`), or null. */
export function ecardReason(task: string, repos: readonly string[]): string | null {
  const key = /\b[A-Z][A-Z0-9]*-\d+\b/.exec(task)
  if (key) return `issue-key ${key[0]}`
  if (/\bPRs?\b/.test(task)) return 'PR'
  if (/pull request/i.test(task)) return 'pull-request'
  const lower = task.toLowerCase()
  if (lower.includes('ecard')) return 'ecard'
  const repo = repos.find((r) => new RegExp(`(?<![\\w-])${escape(r)}(?![\\w-])`).test(lower))
  return repo ? `repo:${repo}` : null
}

/**
 * Who answers an `@computer` task (SPEC.md "Who answers"): a name in the task, else Astra for eCard
 * work, else the assistant whose thread the chat is, else Nova.
 */
export function routeTask(
  task: string,
  agents: readonly ComputerAssistant[],
  chatAgent: string | null,
  repos: readonly string[],
): RouteDecision {
  const work = agents.find((a) => a.profile === 'work') ?? agents.find((a) => a.id === 'astra')
  const personal =
    agents.find((a) => a.id === 'nova') ??
    agents.find((a) => a.profile === 'personal') ??
    agents[0]!
  const named = addressed(task, agents)
  if (named) return { ...named, reason: `addressed:${named.assistant.title}` }
  const ecard = ecardReason(task, repos)
  if (ecard && work) return { assistant: work, task, reason: ecard }
  const thread = chatAgent ? agents.find((a) => a.id === chatAgent) : undefined
  if (thread) return { assistant: thread, task, reason: `thread:${thread.id}` }
  return { assistant: personal, task, reason: 'default' }
}
