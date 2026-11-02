import { useCallback, useEffect, useRef, useState } from 'react'
import type { SetupDetect, SetupRun, SetupState, SetupStep } from '@evaos/contract'
import { SETUP_STEPS } from '@evaos/contract'
import { invoke, on } from '../ipc'

export interface RunOutcome {
  ok: boolean
  version?: string
  message?: string
}

export interface RunProgress {
  percent: number | null
  line: string
}

/** Runs one setup script; `onProgress` hears each of its lines. Never rejects. */
export async function runSetup(
  run: SetupRun,
  onProgress: (p: RunProgress) => void = () => {},
): Promise<RunOutcome> {
  const runId = crypto.randomUUID()
  const off = on('setup.progress', (p) => {
    if (p.runId === runId) onProgress({ percent: p.percent, line: p.line })
  })
  try {
    const r = await invoke('setup.run', { runId, run })
    return r.ok ? r.value : { ok: false, message: r.error.message }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    off()
  }
}

export type RunStatus = 'idle' | 'running' | 'ok' | 'err'

export interface RunView {
  status: RunStatus
  percent: number
  line: string
  message: string
  version: string
}

const IDLE: RunView = { status: 'idle', percent: 0, line: '', message: '', version: '' }

/** One script run as component state: start it, watch percent and the latest line. */
export function useSetupRun(): { view: RunView; start(run: SetupRun): Promise<RunOutcome> } {
  const [view, setView] = useState<RunView>(IDLE)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const start = useCallback(async (run: SetupRun): Promise<RunOutcome> => {
    setView({ ...IDLE, status: 'running' })
    const out = await runSetup(run, (p) => {
      if (!alive.current) return
      setView((v) => ({ ...v, percent: p.percent ?? v.percent, line: p.line }))
    })
    if (alive.current) {
      setView((v) => ({
        ...v,
        status: out.ok ? 'ok' : 'err',
        percent: out.ok ? 100 : v.percent,
        message: out.message ?? '',
        version: out.version ?? '',
      }))
    }
    return out
  }, [])
  return { view, start }
}

/** The first step the wizard has not finished yet. */
export function firstIncomplete(state: SetupState): SetupStep {
  return SETUP_STEPS.find((s) => !state.done.includes(s)) ?? 'done'
}

/** Tools `detect.sh` found missing, in install order. relay-host is installed by its own step. */
export function missingTools(
  d: SetupDetect,
): Array<'clt' | 'brew' | 'bun' | 'omp' | 'herdr' | 'tailscale'> {
  const rows = [
    ['clt', d.clt.installed],
    ['brew', d.brew.installed],
    ['bun', d.bun.installed],
    ['omp', d.omp.installed],
    ['herdr', d.herdr.installed],
    ['tailscale', d.tailscale.installed],
  ] as const
  return rows.filter(([, installed]) => !installed).map(([tool]) => tool)
}

export const TOOL_LABEL: Record<string, string> = {
  clt: 'Apple command line tools (git)',
  brew: 'Homebrew',
  bun: 'Bun',
  omp: 'omp (the AI engine)',
  herdr: 'herdr (keeps chats running)',
  tailscale: 'Tailscale (links your phone)',
}

/** `^[a-z][a-z0-9-]*$` id from a display name, unique among `taken`. */
export function assistantId(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^[^a-z]+/, '')
      .replace(/-+$/, '')
      .slice(0, 30) || 'assistant'
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`
  return id
}

/** Avatar paper/accent colors by assistant position; scaffold-home.sh writes the same into agents.json. */
export const AVATAR_PALETTE: ReadonlyArray<{ paper: string; accent: string }> = [
  { paper: '#ffe3e3', accent: '#1c7ed6' },
  { paper: '#e7f5ff', accent: '#f76707' },
  { paper: '#ebfbee', accent: '#2f9e44' },
  { paper: '#fff3bf', accent: '#e03131' },
  { paper: '#f3d9fa', accent: '#7048e8' },
  { paper: '#d0ebff', accent: '#0c8599' },
]
