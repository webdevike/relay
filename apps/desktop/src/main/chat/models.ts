import { spawn } from 'node:child_process'
import { LineFramer } from '@evaos/chat-core/line-framer'
import { foldModels, parseModels, type ModelInfo } from '@evaos/chat-core/launch'
import type { Command } from '../eva/spawn'

const CATALOG_ID = 'evaos-models'
const DEFAULT_TIMEOUT_MS = 20_000

export interface ModelCatalogOptions {
  cmd: () => Promise<Command>
  cwd: string
  timeoutMs?: number
}

/**
 * omp's model catalog from one throwaway `omp --mode rpc --no-session` process that answers
 * `get_available_models` and is then told to finish by closing its stdin. A success is cached
 * for the life of the app; a failure is not, so the next call tries again. The child is this
 * module's own and is never signalled: a hung one gets its stdin closed and is left to exit.
 */
export class ModelCatalog {
  private cached: ModelInfo[] | null = null
  private inflight: Promise<ModelInfo[]> | null = null

  constructor(private o: ModelCatalogOptions) {}

  /** The catalog when it has already been loaded, else null. Never starts a process. */
  peek(): readonly ModelInfo[] | null {
    return this.cached
  }

  list(): Promise<ModelInfo[]> {
    if (this.cached) return Promise.resolve(this.cached)
    if (!this.inflight) {
      this.inflight = this.fetch()
        .then((models) => {
          this.cached = models
          return models
        })
        .finally(() => {
          this.inflight = null
        })
    }
    return this.inflight
  }

  private async fetch(): Promise<ModelInfo[]> {
    const cmd = await this.o.cmd()
    return new Promise<ModelInfo[]>((resolve, reject) => {
      const child = spawn(cmd.file, cmd.argv, {
        cwd: this.o.cwd,
        env: cmd.env,
        stdio: ['pipe', 'pipe', 'ignore'],
        shell: false,
      })
      let settled = false
      const done = (err: Error | null, models?: ModelInfo[]): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // Closing stdin is how omp is told to finish.
        child.stdin?.end()
        if (err) reject(err)
        else resolve(models ?? [])
      }
      const timer = setTimeout(
        () => done(new Error('The model list did not arrive in time.')),
        this.o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )
      const framer = new LineFramer((f) => {
        if (f.id !== CATALOG_ID) return
        if (f.success === false) {
          done(new Error('omp could not list models.'))
          return
        }
        done(null, foldModels(parseModels(f.data)))
      })
      child.stdout?.on('data', (d: Buffer) => framer.push(d))
      child.once('error', (e) => done(e))
      child.once('exit', () => done(new Error('omp exited before listing models.')))
      child.stdin?.on('error', () => undefined)
      child.stdin?.write(JSON.stringify({ id: CATALOG_ID, type: 'get_available_models' }) + '\n')
    })
  }
}
