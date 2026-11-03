// A cache whose reads never wait: `get` returns what it holds (null before the first fetch) and
// queues a refresh when the value is old. Fetches run one at a time; a failed key backs off.

export interface BackgroundCacheOptions {
  /** Called after a refresh changed a value `get` returns. */
  onChange: () => void
  now?: () => number
  /** Refetched after this long while Isaac looks at it (the popover is open)... */
  hotMs: number
  /** ...and after this long otherwise. */
  coldMs: number
  /** After a failed fetch (null or a throw) the key waits this long. */
  backoffMs: number
}

interface Entry<V> {
  value: V | null
  /** The last attempt, success or not. */
  triedAt: number
  failed: boolean
}

export class BackgroundCache<V> {
  private readonly entries = new Map<string, Entry<V>>()
  private readonly queue: Array<{ key: string; fetch: () => Promise<V | null> }> = []
  /** Queued or being fetched. */
  private readonly pending = new Set<string>()
  private draining: Promise<void> | null = null
  private readonly now: () => number

  constructor(private readonly o: BackgroundCacheOptions) {
    this.now = o.now ?? Date.now
  }

  get(key: string, hot: boolean, fetch: () => Promise<V | null>): V | null {
    const e = this.entries.get(key)
    const age = e === undefined ? Infinity : this.now() - e.triedAt
    const due = e?.failed ? this.o.backoffMs : hot ? this.o.hotMs : this.o.coldMs
    if (age >= due && !this.pending.has(key)) {
      this.pending.add(key)
      this.queue.push({ key, fetch })
      this.kick()
    }
    return e?.value ?? null
  }

  /** Resolves once nothing is queued (tests). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining
  }

  /** Starts a drain unless one runs; a key queued while the last drain wound down starts another. */
  private kick(): void {
    this.draining ??= this.drain().finally(() => {
      this.draining = null
      if (this.queue.length > 0) this.kick()
    })
  }

  private async drain(): Promise<void> {
    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      const before = this.entries.get(next.key)
      const startedAt = this.now()
      let value: V | null = null
      try {
        value = await next.fetch()
      } catch {
        value = null
      }
      this.entries.set(next.key, {
        value: value ?? before?.value ?? null,
        triedAt: startedAt,
        failed: value === null,
      })
      this.pending.delete(next.key)
      if (value !== null && JSON.stringify(before?.value ?? null) !== JSON.stringify(value)) {
        this.o.onChange()
      }
    }
  }
}
