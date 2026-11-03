export interface WriteQueue {
  enqueue<T>(fn: () => T | Promise<T>): Promise<T>
}

/** Serialises config writes. A failing task rejects its own promise but never breaks the chain. */
export function createWriteQueue(): WriteQueue {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
      const run = tail.then(fn)
      tail = run.catch(() => undefined)
      return run
    },
  }
}
