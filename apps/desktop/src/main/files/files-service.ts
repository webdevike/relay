import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { FileContent, FileEntry, FileVersion, GitStatus, SearchResult } from '@evaos/contract'
import type { Place } from '@evaos/chat-core/work'
import { createPathQueue, withEvaFsWrite } from '@evaos/eva-core'
import { CodedError } from '../chat/session-ops'
import {
  MAX_TEXT_BYTES,
  checkRel,
  decodeText,
  hasLockedSegment,
  isInsideRoot,
  resolveInRoot,
} from './files-fs'
import { createGitStatusCache, type ChildEnv } from './files-git'
import { allFiles, createSearch, type SearchQuery } from './files-search'
import { createFilesWatch, type WatchTarget } from './files-watch'

/** Images up to this open as a picture; larger ones are too large. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
}

/** Case-insensitive, numbers by value (file2 before file10). */
const byName = new Intl.Collator(undefined, { sensitivity: 'accent', numeric: true })

export const CHANGED_ON_DISK_MESSAGE = 'The file changed on disk. Your edits are kept.'

export interface FilesServiceDeps {
  /** The root when no chat is open, and the fallback when a chat's folders are gone. */
  evaRoot: string
  /** A chat session's place; throws for a file that is not a listed session, null if unreadable. */
  placeOf: (file: string) => Place | null
  env: ChildEnv
  /** The rg binary, or null to search with git grep or the JS scan. */
  rgPath: () => Promise<string | null>
  /** `files.changed` for one root. */
  emitChanged: (root: string, paths: string[]) => void
  watchDebounceMs?: number
}

export interface SaveInput {
  root: string
  path: string
  text: string
  expected: FileVersion | null
  force: boolean
}

export interface FilesService {
  root(file: string | null): Promise<{ root: string; name: string }>
  list(root: string, dir: string): Promise<{ entries: FileEntry[] }>
  read(root: string, rel: string): Promise<FileContent>
  save(input: SaveInput): Promise<{ version: FileVersion }>
  gitStatus(root: string): Promise<GitStatus>
  all(root: string): Promise<{ files: string[]; truncated: boolean }>
  search(root: string, q: SearchQuery): Promise<SearchResult>
  watch(root: string, paths: readonly string[]): Promise<Record<string, never>>
  /** The absolute path to show in Finder, after the same checks as every other call. */
  revealPath(root: string, rel: string): Promise<string>
  close(): Promise<void>
}

const sha1 = (buf: Buffer): string => createHash('sha1').update(buf).digest('hex')

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** One listing entry; null for sockets, pipes and devices (nothing the editor can open). */
async function entryOf(
  root: string,
  dirReal: string,
  dirRel: string,
  d: fs.Dirent,
): Promise<FileEntry | null> {
  const base = { name: d.name, path: dirRel === '' ? d.name : `${dirRel}/${d.name}` }
  const secret = d.name === 'secrets'
  if (d.isSymbolicLink()) {
    try {
      const real = await fs.promises.realpath(path.join(dirReal, d.name))
      const st = await fs.promises.stat(real)
      const locked =
        secret ||
        !isInsideRoot(root, real) ||
        hasLockedSegment(path.relative(root, real).split(path.sep).join('/')) ||
        !(st.isDirectory() || st.isFile())
      return { ...base, kind: st.isDirectory() ? 'dir' : 'file', symlink: true, locked }
    } catch {
      // A broken link.
      return { ...base, kind: 'file', symlink: true, locked: true }
    }
  }
  if (d.isDirectory()) return { ...base, kind: 'dir', symlink: false, locked: secret }
  if (d.isFile()) return { ...base, kind: 'file', symlink: false, locked: secret }
  return null
}

/**
 * The Files panel's main side, free of electron. Main serves only roots it handed out through
 * `root()`; every other call fails `unknown-root` for anything else, and every path goes through
 * `resolveInRoot` (no `..`, no escaping symlink, no `.git`, no `secrets`).
 *
 * Own saves: the watcher still reports a file this service just saved. The renderer re-reads it
 * and compares the hash with the version the save returned; equal means nothing changed.
 */
export function createFilesService(deps: FilesServiceDeps): FilesService {
  const roots = new Set<string>()
  const saves = createPathQueue()
  const status = createGitStatusCache(deps.env)
  const searcher = createSearch(deps.env, deps.rgPath)
  const watcher = createFilesWatch(deps.emitChanged, { debounceMs: deps.watchDebounceMs })

  const known = async (root: string): Promise<string> => {
    let real: string
    try {
      real = await fs.promises.realpath(root)
    } catch {
      throw new CodedError('unknown-root', 'This folder is not open in the Files panel.')
    }
    if (!roots.has(real)) {
      throw new CodedError('unknown-root', 'This folder is not open in the Files panel.')
    }
    return real
  }

  return {
    async root(file) {
      let dir = deps.evaRoot
      if (file !== null) {
        const place = deps.placeOf(file)
        for (const candidate of [place?.active, place?.cwd]) {
          if (candidate && (await isDir(candidate))) {
            dir = candidate
            break
          }
        }
      }
      let real: string
      try {
        real = await fs.promises.realpath(dir)
      } catch {
        throw new CodedError('not-found', 'The folder no longer exists.')
      }
      roots.add(real)
      return { root: real, name: path.basename(real) }
    },

    async list(root, dir) {
      const r = await known(root)
      const t = await resolveInRoot(r, dir)
      if (!(await isDir(t.real))) throw new CodedError('not-a-folder', 'This is not a folder.')
      const dirents = await fs.promises.readdir(t.real, { withFileTypes: true })
      const all = await Promise.all(
        dirents.filter((d) => d.name !== '.git').map((d) => entryOf(r, t.real, t.rel, d)),
      )
      const entries = all.filter((e): e is FileEntry => e !== null)
      entries.sort((a, b) =>
        a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : byName.compare(a.name, b.name),
      )
      return { entries }
    },

    async read(root, rel) {
      const t = await resolveInRoot(await known(root), rel)
      const st = await fs.promises.stat(t.real)
      if (!st.isFile()) throw new CodedError('not-a-file', 'This is not a file.')
      const ext = path.extname(t.rel).slice(1).toLowerCase()
      const mime = Object.hasOwn(IMAGE_MIME, ext) ? IMAGE_MIME[ext] : undefined
      if (mime !== undefined && st.size <= MAX_IMAGE_BYTES) {
        const buf = await fs.promises.readFile(t.real)
        const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
        return { kind: 'image', mime, dataUrl, size: buf.length }
      }
      if (st.size > MAX_TEXT_BYTES) return { kind: 'too-large', size: st.size }
      const buf = await fs.promises.readFile(t.real)
      const text = decodeText(buf)
      if (text === null) return { kind: 'binary', size: buf.length }
      const version = { mtimeMs: st.mtimeMs, size: buf.length, hash: sha1(buf) }
      return { kind: 'text', text, version }
    },

    async save(input) {
      // Queued by the path as asked, before any await, so saves land in the order they came.
      return saves.run(`${input.root}\0${checkRel(input.path)}`, async () => {
        const t = await resolveInRoot(await known(input.root), input.path)
        let st: fs.Stats
        try {
          st = await fs.promises.lstat(t.real)
        } catch {
          throw new CodedError('not-found', 'The file no longer exists.')
        }
        if (!st.isFile()) throw new CodedError('not-found', 'The file no longer exists.')
        if (!input.force) {
          const disk = await fs.promises.readFile(t.real)
          if (input.expected === null || sha1(disk) !== input.expected.hash) {
            throw new CodedError('changed-on-disk', CHANGED_ON_DISK_MESSAGE)
          }
        }
        const data = Buffer.from(input.text, 'utf8')
        const mode = st.mode & 0o7777
        const dir = path.dirname(t.real)
        const rand = randomBytes(6).toString('hex')
        const temp = path.join(dir, `.${path.basename(t.real)}.${process.pid}.${rand}.tmp`)
        await withEvaFsWrite(async () => {
          try {
            const fh = await fs.promises.open(temp, 'wx', mode)
            try {
              await fh.writeFile(data)
              // open's mode passes through the umask; the original mode is restored exactly.
              await fh.chmod(mode)
              await fh.sync()
            } finally {
              await fh.close()
            }
            await fs.promises.rename(temp, t.real)
          } catch (e) {
            await fs.promises.rm(temp, { force: true }).catch(() => undefined)
            throw e
          }
        })
        const after = await fs.promises.stat(t.real)
        return { version: { mtimeMs: after.mtimeMs, size: data.length, hash: sha1(data) } }
      })
    },

    async gitStatus(root) {
      return status(await known(root))
    },

    async all(root) {
      const r = await known(root)
      return allFiles(r, await deps.env())
    },

    async search(root, q) {
      return searcher.search(await known(root), q)
    },

    async watch(root, paths) {
      const r = await known(root)
      const targets: WatchTarget[] = []
      for (const rel of paths) {
        try {
          targets.push({ rel, real: (await resolveInRoot(r, rel)).real })
        } catch {
          // A path that is gone, locked or outside the root is not watched.
        }
      }
      watcher.set(r, targets)
      return {}
    },

    async revealPath(root, rel) {
      return (await resolveInRoot(await known(root), rel)).abs
    },

    async close() {
      searcher.cancelAll()
      await watcher.close()
    },
  }
}
