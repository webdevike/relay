import { spawn } from 'node:child_process'
import { LineFramer } from '@evaos/chat-core/line-framer'
import {
  foldModels,
  parseCommands,
  parseModels,
  type ModelInfo,
  type SlashCommand,
} from '@evaos/chat-core/launch'
import type { Command } from '../eva/spawn'

const CATALOG_ID = 'evaos-catalog'
const DEFAULT_TIMEOUT_MS = 20_000

export interface ModelCatalogOptions {
  cmd: () => Promise<Command>
  cwd: string
  timeoutMs?: number
}

/**
 * One answer from a throwaway `omp --mode rpc --no-session` process, cached: the process gets
 * `request`, and is told to finish by closing its stdin. A success is cached for the life of the
 * app; a failure is not, so the next call tries again. The child is this module's own and is
 * never signalled: a hung one gets its stdin closed and is left to exit.
 */
class OmpCatalog<T> {
  private cached: T | null = null
  private inflight: Promise<T> | null = null

  constructor(
    private o: ModelCatalogOptions,
    private request: string,
    private what: string,
    private parse: (data: unknown) => T,
  ) {}

  /** The catalog when it has already been loaded, else null. Never starts a process. */
  peek(): T | null {
    return this.cached
  }

  list(): Promise<T> {
    if (this.cached) return Promise.resolve(this.cached)
    if (!this.inflight) {
      this.inflight = this.fetch()
        .then((value) => {
          this.cached = value
          return value
        })
        .finally(() => {
          this.inflight = null
        })
    }
    return this.inflight
  }

  private async fetch(): Promise<T> {
    const cmd = await this.o.cmd()
    return new Promise<T>((resolve, reject) => {
      const child = spawn(cmd.file, cmd.argv, {
        cwd: this.o.cwd,
        env: cmd.env,
        stdio: ['pipe', 'pipe', 'ignore'],
        shell: false,
      })
      let settled = false
      const done = (err: Error | null, value?: T): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // Closing stdin is how omp is told to finish.
        child.stdin?.end()
        if (err) reject(err)
        else resolve(value as T)
      }
      const timer = setTimeout(
        () => done(new Error(`The ${this.what} list did not arrive in time.`)),
        this.o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )
      const framer = new LineFramer((f) => {
        if (f.id !== CATALOG_ID) return
        if (f.success === false) {
          done(new Error(`omp could not list ${this.what}s.`))
          return
        }
        done(null, this.parse(f.data))
      })
      child.stdout?.on('data', (d: Buffer) => framer.push(d))
      child.once('error', (e) => done(e))
      child.once('exit', () => done(new Error(`omp exited before listing ${this.what}s.`)))
      child.stdin?.on('error', () => undefined)
      child.stdin?.write(JSON.stringify({ id: CATALOG_ID, type: this.request }) + '\n')
    })
  }
}

/** omp's model catalog (`get_available_models`), newest first. */
export class ModelCatalog extends OmpCatalog<ModelInfo[]> {
  constructor(o: ModelCatalogOptions) {
    super(o, 'get_available_models', 'model', (d) => foldModels(parseModels(d)))
  }
}

/** omp's slash commands (`get_available_commands`) for the composer's `/` menu. */
export class CommandCatalog extends OmpCatalog<SlashCommand[]> {
  constructor(o: ModelCatalogOptions) {
    super(o, 'get_available_commands', 'command', parseCommands)
  }
}
