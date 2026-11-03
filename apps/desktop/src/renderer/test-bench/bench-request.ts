/**
 * An experiment another surface (agent control) asked Test Bench to open. A mounted page takes
 * it at once; otherwise it waits for the page's first render.
 */
let pending: string | null = null
let listener: ((id: string) => void) | null = null

export function requestExperiment(id: string): void {
  if (listener) listener(id)
  else pending = id
}

export function takeExperimentRequest(): string | null {
  const id = pending
  pending = null
  return id
}

export function onExperimentRequest(fn: (id: string) => void): () => void {
  listener = fn
  return () => {
    if (listener === fn) listener = null
  }
}
