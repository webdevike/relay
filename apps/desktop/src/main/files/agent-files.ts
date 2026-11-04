import * as fs from 'node:fs'
import * as path from 'node:path'
import type { FileContent, FileEntry, FileVersion } from '@evaos/contract'
import { CodedError } from '../chat/session-ops'
import {
  type AgentFile,
  type AgentFileRead,
  type AgentFileVersion,
  type HostAgentFiles,
} from '../relay/host-agent-files'
import type { SaveInput } from './files-service'

/**
 * An assistant's two instruction files for the Files tab. On the Mac that runs omp they are the
 * real files under the Eva root (`localAgentFiles`; the ordinary Files service opens them). On a
 * thin client they live in the Mini's agent home, so the tab gets a virtual root, one per
 * assistant, holding just `prime.md` and `thread.md`, read and saved through the Mini's Relay Host.
 */
export const HOST_ROOT_PREFIX = '/relay-host/'

export interface AgentFilesOpened {
  root: string
  name: string
  /** Root-relative paths of the two files. */
  prime: string
  thread: string
  /** True when the files are the Mini's (a virtual root), false when they are on this Mac. */
  remote: boolean
}

const FILES: Readonly<Record<string, AgentFile>> = { 'prime.md': 'prime', 'thread.md': 'thread' }

/** How often a watched host file is checked for changes made on the Mini. */
export const POLL_MS = 3000

/** Where agent `id`'s prime and thread memory live under `home` (the rule of the host's `threadFile`). */
export function localAgentFiles(home: string, id: string): { prime: string; thread: string } {
  const eva = fs.existsSync(path.join(home, 'work', 'eva', 'agents'))
  return {
    prime: `.omp/assistant/agents/${id}/prime.md`,
    thread: `work/${eva ? 'eva/' : ''}agents/${id}/thread.md`,
  }
}

export const isHostRoot = (root: string): boolean => root.startsWith(HOST_ROOT_PREFIX)

export interface AgentFilesDeps {
  host: HostAgentFiles
  /** `files.changed` for one virtual root. */
  emitChanged: (root: string, paths: string[]) => void
  pollMs?: number
}

export interface AgentFilesService {
  open(agent: string): AgentFilesOpened
  /** The host's absolute path of a file of a virtual root, once a read, save or poll has told it; null for anything else. */
  hostPathOf(root: string, rel: string): string | null
  list(root: string, dir: string): { entries: FileEntry[] }
  read(root: string, rel: string): Promise<FileContent>
  save(input: SaveInput): Promise<{ version: FileVersion }>
  watch(root: string, wanted: readonly string[]): Record<string, never>
  close(): void
}

const fileVersion = (v: AgentFileVersion): FileVersion => ({
  mtimeMs: v.mtimeMs,
  size: v.size,
  hash: v.hash,
})

export function createAgentFiles(deps: AgentFilesDeps): AgentFilesService {
  const roots = new Set<string>()
  /** The last hash seen per `root\0rel`, so a poll reports only what changed. */
  const seen = new Map<string, string>()
  /** The host's absolute path per `root\0rel`, as its answers report it. */
  const paths = new Map<string, string>()
  const remember = (key: string, answer: AgentFileRead): void => {
    seen.set(key, answer.version.hash)
    if (typeof answer.path === 'string') paths.set(key, answer.path)
  }
  let watching: { root: string; rels: string[] } | null = null
  let timer: NodeJS.Timeout | undefined

  const resolve = (root: string, rel: string): { agent: string; file: AgentFile } => {
    const agent = root.slice(HOST_ROOT_PREFIX.length)
    if (!roots.has(root)) {
      throw new CodedError('unknown-root', 'This folder is not open in the Files panel.')
    }
    const file = Object.hasOwn(FILES, rel) ? FILES[rel] : undefined
    if (file === undefined)
      throw new CodedError('not-found', 'Only prime.md and thread.md are here.')
    return { agent, file }
  }

  /** Host refusals keep their code (`changed-on-disk`, `not-found`); others surface as one-line errors. */
  const call = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code
      throw new CodedError(
        typeof code === 'string' && /^[a-z][a-z-]*$/.test(code) ? code : 'host-unavailable',
        e instanceof Error ? e.message : String(e),
      )
    }
  }

  const poll = async (): Promise<void> => {
    const w = watching
    if (!w) return
    for (const rel of w.rels) {
      let agentFile: { agent: string; file: AgentFile }
      try {
        agentFile = resolve(w.root, rel)
      } catch {
        continue
      }
      const key = `${w.root}\0${rel}`
      try {
        const answer = (await deps.host.req({
          op: 'version',
          ...agentFile,
        })) as unknown as AgentFileRead
        const prev = seen.get(key)
        remember(key, answer)
        if (prev !== undefined && prev !== answer.version.hash && watching === w) {
          deps.emitChanged(w.root, [rel])
        }
      } catch {
        // Not connected or the file is gone: nothing to report until the host answers.
      }
    }
  }

  return {
    open(agent) {
      const root = `${HOST_ROOT_PREFIX}${agent}`
      roots.add(root)
      return {
        root,
        name: `${agent} instructions`,
        prime: 'prime.md',
        thread: 'thread.md',
        remote: true,
      }
    },

    hostPathOf(root, rel) {
      return paths.get(`${root}\0${rel}`) ?? null
    },

    list(root, dir) {
      if (!roots.has(root)) {
        throw new CodedError('unknown-root', 'This folder is not open in the Files panel.')
      }
      if (dir !== '') throw new CodedError('not-a-folder', 'This is not a folder.')
      const entries: FileEntry[] = Object.keys(FILES).map((name) => ({
        name,
        path: name,
        kind: 'file',
        symlink: false,
        locked: false,
      }))
      return { entries }
    },

    async read(root, rel) {
      const target = resolve(root, rel)
      const answer = (await call(() =>
        deps.host.req({ op: 'read', ...target }),
      )) as unknown as AgentFileRead
      remember(`${root}\0${rel}`, answer)
      if (answer.kind !== 'text' || answer.text === undefined) {
        return {
          kind: answer.kind === 'too-large' ? 'too-large' : 'binary',
          size: answer.version.size,
        }
      }
      return { kind: 'text', text: answer.text, version: fileVersion(answer.version) }
    },

    async save(input) {
      const target = resolve(input.root, input.path)
      const answer = (await call(() =>
        deps.host.req({
          op: 'save',
          ...target,
          text: input.text,
          expectedHash: input.expected?.hash ?? null,
          force: input.force,
        }),
      )) as unknown as AgentFileRead
      remember(`${input.root}\0${input.path}`, answer)
      return { version: fileVersion(answer.version) }
    },

    watch(root, wanted) {
      clearInterval(timer)
      watching = null
      const rels = wanted.filter((p) => Object.hasOwn(FILES, p))
      if (roots.has(root) && rels.length > 0) {
        watching = { root, rels }
        timer = setInterval(() => void poll(), deps.pollMs ?? POLL_MS)
      }
      return {}
    },

    close() {
      clearInterval(timer)
      watching = null
    },
  }
}
