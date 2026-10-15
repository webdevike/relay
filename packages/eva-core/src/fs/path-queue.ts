export interface PathQueue {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>
}

/** Serialises jobs per key. A failing job rejects its own promise but never blocks the next one. */
export function createPathQueue(): PathQueue {
  const tails = new Map<string, Promise<unknown>>()
  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prev = tails.get(key) ?? Promise.resolve()
      const result = prev.then(fn)
      const tail: Promise<unknown> = result.then(
        () => undefined,
        () => undefined,
      )
      tails.set(key, tail)
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key)
      })
      return result
    },
  }
}
