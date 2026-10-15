import { handle, emit } from '../ipc/handle'
import type { MainContext } from '../context'
import { registerTestHook } from '../test-hooks'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { claudeArgs, ompArgs, readApproval, type Approval } from '@evaos/chat-core/launch'
import type { OmpStdioTransport } from './omp-transport'
import { loadSettings } from '../settings-ipc'
import { createChatTransport } from './transport-factory'
import { SessionManager } from './session-manager'
import { machineLabel } from '@evaos/chat-core/tagged'
import type { Batch } from '@evaos/contract'

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** Claude Code's `permissions.defaultMode` as an approval mode (Rust claude_approval). */
function claudeApproval(ctx: MainContext): Approval {
  const files = [
    path.join(ctx.env.evaRoot, '.claude/settings.local.json'),
    path.join(ctx.env.evaRoot, '.claude/settings.json'),
    path.join(os.homedir(), '.claude/settings.json'),
  ]
  for (const f of files) {
    const text = readText(f)
    if (text === null) continue
    try {
      const mode = (JSON.parse(text) as { permissions?: { defaultMode?: unknown } }).permissions
        ?.defaultMode
      if (typeof mode !== 'string') continue
      return mode === 'bypassPermissions' ? 'yolo' : mode === 'acceptEdits' ? 'write' : 'always-ask'
    } catch {
      continue
    }
  }
  return 'yolo'
}

/** Default flags for a new chat: the approval mode its harness is configured with. */
export function defaultLaunchArgs(ctx: MainContext, harness: 'omp' | 'claude'): string[] {
  if (harness === 'claude') return claudeArgs({ approval: claudeApproval(ctx), profile: null })
  const approval = readApproval(
    readText(path.join(ctx.env.evaRoot, '.omp/config.yml')),
    readText(path.join(ctx.env.agentDir, 'config.yml')),
  )
  return ompArgs({ approval, profile: null })
}

export function createSessionManager(ctx: MainContext): SessionManager {
  const dropNext = new Set<string>()
  let extraEnv: Record<string, string> = {}
  const manager: SessionManager = new SessionManager({
    cwd: ctx.env.evaRoot,
    machineLabel: machineLabel(),
    createTransport: () =>
      createChatTransport(ctx, () => {
        const e = extraEnv
        extraEnv = {}
        return e
      }).transport,
    launchArgs: (harness) => defaultLaunchArgs(ctx, harness),
    emit: (batch: Batch) => {
      // Test hook: the batch consumed a seq but never reaches the renderer (gap recovery e2e).
      if (dropNext.delete(batch.paneId)) return
      emit(ctx, 'chat.batch', batch)
    },
  })
  if (ctx.env.e2e) {
    registerTestHook('chat', {
      dropNextBatch: (paneId: string) => {
        dropNext.add(paneId)
      },
      setFakeEnv: (env: Record<string, string>) => {
        extraEnv = { ...env }
      },
      stats: (paneId: string) => {
        const t = manager.transportOf(paneId) as OmpStdioTransport | null
        return {
          ...manager.stats(paneId),
          spawnArgs: t?.spawnArgs ?? [],
          pid: t?.pid ?? null,
          cwd: t?.spawnCwd ?? '',
        }
      },
    })
  }
  return manager
}

export function registerLiveIpc(ctx: MainContext, manager: SessionManager): void {
  handle(ctx, 'chat.send', async ({ paneId, text, images }) => {
    await manager.send(paneId, text, images ? { images } : {})
    return { accepted: true as const }
  })
  handle(ctx, 'chat.abort', async ({ paneId }) => ({ sent: await manager.abort(paneId) }))
  handle(ctx, 'chat.close', async ({ paneId }) => ({ exit: await manager.close(paneId) }))
  handle(ctx, 'chat.openDraft', ({ paneId }) => {
    const meta = { model: null, thinking: null, contextTokens: null }
    manager.openDraft(paneId, meta)
    return { meta, harness: loadSettings(ctx.config).harness }
  })
  handle(ctx, 'chat.snapshot', ({ paneId }) => manager.snapshot(paneId))
}
