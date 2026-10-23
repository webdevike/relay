import * as fs from 'node:fs'
import * as os from 'node:os'
import type { ChatAgent } from '@evaos/contract'
import { isRecentlyActive } from '@evaos/chat-core/chat-groups'
import { sessionId } from '@evaos/chat-core/session-id'
import { renameArgs } from '@evaos/chat-core/launch'
import type { ConfigStore } from '../config-store'
import type { MainContext } from '../context'
import { buildCommand, childPathFor } from '../eva/spawn'
import { handle } from '../ipc/handle'
import type { WriteQueue } from '../write-queue'
import { SESSION_ID_RE, type ChatListService } from './chat-list'
import {
  CHAT_RUNNING_MESSAGE,
  CodedError,
  MAYBE_RUNNING_MESSAGE,
  deleteSession,
  readPins,
  renameViaResume,
  writePins,
} from './session-ops'
import type { SessionManager } from './session-manager'
import { resolveInsideSessionsDir } from './transcript-ipc'

const CHAT_FILE = 'chat.json'

/** One read-modify-write of chat.json that changes only `collapsed_groups`; unknown keys survive. */
export function saveCollapsed(config: ConfigStore, groups: readonly string[]): { saved: true } {
  const existing = config.readForMerge(CHAT_FILE)
  config.writeJson(CHAT_FILE, { ...existing, collapsed_groups: [...new Set(groups)] })
  return { saved: true }
}

export interface CategoryWrite {
  chat_categories: string[]
  chat_group_order: string[]
  chat_assignments: Record<string, string>
}

/** One read-modify-write of chat.json that changes only the three category keys. */
export function saveCategories(config: ConfigStore, next: CategoryWrite): { saved: true } {
  const existing = config.readForMerge(CHAT_FILE)
  config.writeJson(CHAT_FILE, {
    ...existing,
    chat_categories: next.chat_categories,
    chat_group_order: next.chat_group_order,
    chat_assignments: next.chat_assignments,
  })
  return { saved: true }
}

/** Adds or removes one id in chat.json `archived_chats` (sorted); every other key survives. */
export function saveArchived(
  config: ConfigStore,
  id: string,
  archived: boolean,
): { archived: string[] } {
  const existing = config.readForMerge(CHAT_FILE)
  const current = Array.isArray(existing.archived_chats)
    ? existing.archived_chats.filter((x): x is string => typeof x === 'string')
    : []
  const set = new Set(current)
  if (archived) set.add(id)
  else set.delete(id)
  const next = [...set].sort()
  config.writeJson(CHAT_FILE, { ...existing, archived_chats: next })
  // Entries from the shared file that are not valid ids stay on disk but never reach the output schema.
  return { archived: next.filter((x) => SESSION_ID_RE.test(x)) }
}

/** One read-modify-write of chat.json that changes only `chat_agent`, the tab the list shows. */
export function saveAgent(config: ConfigStore, agent: ChatAgent): { saved: true } {
  const existing = config.readForMerge(CHAT_FILE)
  config.writeJson(CHAT_FILE, { ...existing, chat_agent: agent })
  return { saved: true }
}

/** Pins or unpins one id in omp's pins file, keeping every other pin. */
export function savePin(agentDir: string, id: string, pinned: boolean): { pins: string[] } {
  const set = new Set(readPins(agentDir))
  if (pinned) set.add(id)
  else set.delete(id)
  return { pins: writePins(agentDir, [...set]).filter((x) => SESSION_ID_RE.test(x)) }
}

export interface ChatOpsDeps {
  /** Every sessions dir the list spans; a chat outside them is refused. */
  sessionsDirs: readonly string[]
  agentDir: string
  config: ConfigStore
  service: Pick<ChatListService, 'invalidate' | 'setTitle' | 'forget'>
  manager: Pick<SessionManager, 'ownerOf' | 'renameOwned' | 'renameAway'>
  /** Short `omp --mode rpc --resume` rename of a file nothing runs. */
  resume: (file: string, name: string) => Promise<void>
  emitList: () => void
  now?: () => number
}

/**
 * Rename order (Rust apply_rename): owned chat through its own omp, a chat running outside this app
 * through Relay (native rename_away), a recently active unowned chat is refused, otherwise a short
 * resume. `file` is the list's path; `real` is its resolved path.
 */
export async function renameChat(
  d: ChatOpsDeps,
  file: string,
  name: string,
): Promise<{ title: string; via: 'rpc' | 'resume' | 'relay' }> {
  const real = resolveInsideSessionsDir(d.sessionsDirs, file)
  if (d.manager.ownerOf(real) !== null && (await d.manager.renameOwned(real, name))) {
    d.service.setTitle(file, name)
    d.emitList()
    return { title: name, via: 'rpc' }
  }
  if (await d.manager.renameAway(real, name)) {
    d.service.setTitle(file, name)
    d.emitList()
    return { title: name, via: 'relay' }
  }
  const now = (d.now ?? Date.now)()
  if (isRecentlyActive(fs.statSync(real).mtimeMs, now)) {
    throw new CodedError('maybe-running', MAYBE_RUNNING_MESSAGE)
  }
  await d.resume(real, name)
  d.service.invalidate(file)
  d.emitList()
  return { title: name, via: 'resume' }
}

/** Deletes an idle chat; an owned or recently active one is refused. Also forgets its pin, settle and order marks. */
export function deleteChat(d: ChatOpsDeps, file: string): { deleted: true } {
  const real = resolveInsideSessionsDir(d.sessionsDirs, file)
  const now = (d.now ?? Date.now)()
  if (d.manager.ownerOf(real) !== null || isRecentlyActive(fs.statSync(real).mtimeMs, now)) {
    throw new CodedError('chat-running', CHAT_RUNNING_MESSAGE)
  }
  deleteSession(real)
  const id = sessionId(real)
  if (readPins(d.agentDir).includes(id)) savePin(d.agentDir, id, false)
  const archived = d.config.readForMerge(CHAT_FILE).archived_chats
  if (Array.isArray(archived) && archived.includes(id)) saveArchived(d.config, id, false)
  d.service.forget(id)
  d.service.invalidate(file)
  d.emitList()
  return { deleted: true }
}

export function registerChatListIpc(
  ctx: MainContext,
  queue: WriteQueue,
  service: ChatListService,
  manager: SessionManager,
  sessionsDirs: readonly string[],
  emitList: () => void = () => undefined,
): void {
  const ops: ChatOpsDeps = {
    sessionsDirs,
    agentDir: ctx.env.agentDir,
    config: ctx.config,
    service,
    manager,
    emitList,
    resume: async (file, name) => {
      const home = os.homedir()
      const cmd = buildCommand(ctx.env.ompBin, renameArgs('omp', file), {
        pathEnv: await childPathFor(ctx.env.live, home),
        homedir: home,
        execPath: process.execPath,
        baseEnv: process.env,
      })
      await renameViaResume({ cmd, cwd: ctx.env.evaRoot, file, name })
    },
  }
  handle(ctx, 'chat.list', () => service.list())
  handle(ctx, 'chat.setCollapsed', ({ groups }) =>
    queue.enqueue(() => saveCollapsed(ctx.config, groups)),
  )
  handle(ctx, 'chat.setCategories', (next) =>
    queue.enqueue(() => {
      const out = saveCategories(ctx.config, next)
      emitList()
      return out
    }),
  )
  handle(ctx, 'chat.pin', ({ id, pinned }) =>
    queue.enqueue(() => {
      const out = savePin(ctx.env.agentDir, id, pinned)
      emitList()
      return out
    }),
  )
  // Settle or unsettle; unsettling records `kept`, so it stays out for another full stretch.
  handle(ctx, 'chat.archive', ({ id, archived }) =>
    queue.enqueue(() => {
      const out = saveArchived(ctx.config, id, archived)
      if (!archived) service.keep(id)
      emitList()
      return out
    }),
  )
  handle(ctx, 'chat.setAgent', ({ agent }) =>
    queue.enqueue(() => {
      const out = saveAgent(ctx.config, agent)
      emitList()
      return out
    }),
  )
  handle(ctx, 'chat.markRead', ({ id }) =>
    queue.enqueue(() => {
      // Showing a read chat changes nothing, so it pushes no list.
      if (service.markRead(id)) emitList()
      return { saved: true as const }
    }),
  )
  handle(ctx, 'chat.snooze', ({ id, untilMs }) =>
    queue.enqueue(() => {
      service.snooze(id, untilMs)
      emitList()
      return { saved: true as const }
    }),
  )
  // Not queued: a short resume can take seconds and must not hold up config writes.
  handle(ctx, 'chat.rename', ({ file, name }) => renameChat(ops, file, name))
  handle(ctx, 'chat.delete', ({ file }) => queue.enqueue(() => deleteChat(ops, file)))
}
