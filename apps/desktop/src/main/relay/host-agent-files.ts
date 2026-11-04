// An assistant's prime.md and thread.md on a thin client: they live in the Mini's agent home, so the
// Files tab reads and saves them through the Mini's Relay Host with `assistant.file.req {rid, agent,
// file, op}`, answered by `assistant.file.res` with the same rid (relay packages/protocol). The host
// serves only those two files per registry agent, never a path.
import { NOT_CONNECTED, RelayCommandError, type RelayFrames } from './client'

/** What an old host (one that does not know the op) leaves us with: nothing comes back. */
export const OLD_HOST_FILES =
  'The Mini’s Relay Host didn’t answer. Update it to edit assistant instructions from here.'
export const FILE_TIMEOUT_MS = 15_000

export type AgentFile = 'prime' | 'thread'

export interface AgentFileVersion {
  mtimeMs: number
  size: number
  hash: string
}

/** The host's answer to a read or version; `text` only for `kind: 'text'`. */
export interface AgentFileRead {
  kind: 'text' | 'binary' | 'too-large'
  text?: string
  /** The file's absolute path on the host. */
  path?: string
  version: AgentFileVersion
}

export type AgentFileRequest =
  | { op: 'read' | 'version'; agent: string; file: AgentFile }
  | {
      op: 'save'
      agent: string
      file: AgentFile
      text: string
      expectedHash: string | null
      force: boolean
    }

/** A refusal from the host, with the code a client acts on (`changed-on-disk`, `not-found`, ...). */
export class HostFileError extends RelayCommandError {}

export interface HostAgentFiles {
  /** One op; resolves with the answer's fields, rejects with the host's refusal, NOT_CONNECTED or OLD_HOST_FILES. */
  req(r: AgentFileRequest): Promise<Record<string, unknown>>
}

export function createHostAgentFiles(
  frames: RelayFrames,
  timeoutMs: number = FILE_TIMEOUT_MS,
): HostAgentFiles {
  let seq = 0
  return {
    req(r) {
      seq += 1
      const rid = `relay-desktop-files-${Date.now().toString(36)}-${seq}`
      const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>()
      const timer = setTimeout(() => {
        off()
        reject(new RelayCommandError('timeout', OLD_HOST_FILES))
      }, timeoutMs)
      const off = frames.onFrame((f) => {
        if (f.t !== 'assistant.file.res' || f.rid !== rid) return
        clearTimeout(timer)
        off()
        if (f.ok === true) {
          const { t: _t, rid: _rid, ok: _ok, ...answer } = f
          resolve(answer)
        } else {
          const code =
            typeof f.code === 'string' && /^[a-z][a-z-]*$/.test(f.code) ? f.code : 'internal'
          const msg = typeof f.error === 'string' && f.error !== '' ? f.error : OLD_HOST_FILES
          reject(new HostFileError(code, msg))
        }
      })
      if (!frames.sendFrame({ t: 'assistant.file.req', rid, ...r })) {
        clearTimeout(timer)
        off()
        reject(new RelayCommandError('not_connected', NOT_CONNECTED))
      }
      return promise
    },
  }
}
