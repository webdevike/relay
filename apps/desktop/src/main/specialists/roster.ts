// The agents the atomic-agents service loads (`atomic-agents list --json`), and where each one's
// files are: an agent folder (`<id>/AGENT.md` with knowledge/ and bench/) opens whole; a spec file
// (`<id>.json|yaml` in its domain folder beside other agents) opens with only its own files: the
// spec, the knowledge it names in that folder, and its bench files.
import * as path from 'node:path'
import { z } from 'zod'
import type { SpecialistAgent } from '@evaos/contract'
import { lastLine, timeOf } from './runs'

const EntryJson = z.object({
  id: z.string().min(1),
  purpose: z.string(),
  kind: z.enum(['spec', 'code']),
  file: z.string().optional(),
  knowledge: z.array(z.string()).default([]),
  enabled: z.boolean(),
  mode: z.enum(['live', 'shadow', 'off']).optional(),
  model: z.string(),
  fallbackModel: z.string().optional(),
  candidates: z.array(z.string()).default([]),
  thinking: z.string().optional(),
  how: z.enum(['ask', 'run']).optional(),
  /** Absent from a service installed before trial mode: off. */
  trial: z.object({ on: z.boolean(), arms: z.array(z.string()) }).optional(),
  runs: z.object({
    week: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    lastAt: z.string().optional(),
  }),
  error: z.string().optional(),
})

/** Where one agent's files are, as the service named them. */
export interface AgentSource {
  id: string
  /** Its agent file: a folder's AGENT.md or its spec (absolute); undefined for code. */
  file: string | undefined
  /** A spec's knowledge files (absolute). */
  knowledge: readonly string[]
}

const AGENT_DOC = 'AGENT.md'

/** `atomic-agents list --json` as the page shows it, and each agent's files; throws when it is not that JSON. */
export function rosterOf(stdout: string): { agents: SpecialistAgent[]; sources: AgentSource[] } {
  const entries = z.array(EntryJson).parse(JSON.parse(lastLine(stdout)))
  return {
    agents: entries.map((e) => ({
      id: e.id.slice(0, 200),
      purpose: e.purpose.slice(0, 2000),
      format:
        e.kind === 'code' || e.file === undefined
          ? 'code'
          : path.basename(e.file) === AGENT_DOC
            ? 'folder'
            : 'file',
      enabled: e.enabled,
      mode: e.mode ?? null,
      model: e.model.slice(0, 200),
      fallbackModel: e.fallbackModel?.slice(0, 200) ?? null,
      candidates: e.candidates.slice(0, 50).map((c) => c.slice(0, 200)),
      thinking: e.thinking?.slice(0, 40) ?? null,
      how: e.how ?? null,
      trial: {
        on: e.trial?.on ?? false,
        arms: (e.trial?.arms ?? []).slice(0, 10).map((m) => m.slice(0, 200)),
      },
      runs: {
        week: e.runs.week,
        failed: e.runs.failed,
        running: e.runs.running,
        lastAt: timeOf(e.runs.lastAt),
      },
      error: e.error?.slice(0, 4000) ?? null,
    })),
    sources: entries.map((e) => ({ id: e.id, file: e.file, knowledge: e.knowledge })),
  }
}

const inside = (dir: string, p: string): boolean => {
  const rel = path.relative(dir, p)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * The folder to open for an agent and what in it to show, or why not. Only agent files inside
 * `allowed` (the installed copy's domains, the home's own agents) open: the renderer names an id,
 * never a path. `bench` lists a folder's file names (missing folder: none).
 */
export function agentFolderOf(
  source: AgentSource,
  allowed: readonly string[],
  bench: (dir: string) => readonly string[],
): { root: string; entry: string; only: string[] | null } {
  const file = source.file
  if (file === undefined)
    throw Object.assign(new Error(`${source.id} is built in code; it has no files to open`), {
      code: 'no-files',
    })
  if (!allowed.some((dir) => inside(dir, file)))
    throw Object.assign(new Error(`${source.id} is not in the installed service`), {
      code: 'outside',
    })
  const root = path.dirname(file)
  if (path.basename(file) === AGENT_DOC) return { root, entry: AGENT_DOC, only: null }
  const own = (name: string): boolean =>
    name.startsWith(`${source.id}.`) || name.startsWith(`${source.id}-`)
  const only = [
    path.basename(file),
    ...source.knowledge.filter((k) => inside(root, k)).map((k) => path.relative(root, k)),
    ...bench(path.join(root, 'bench'))
      .filter(own)
      .map((name) => `bench/${name}`),
  ]
  return { root, entry: path.basename(file), only: [...new Set(only)] }
}
