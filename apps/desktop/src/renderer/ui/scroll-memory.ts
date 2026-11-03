const MAX_KEYS = 200
const memory = new Map<string, number>()

export function getScroll(key: string): number {
  return memory.get(key) ?? 0
}

export function setScroll(key: string, top: number): void {
  memory.delete(key)
  memory.set(key, top)
  while (memory.size > MAX_KEYS) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    memory.delete(oldest)
  }
}

export function resetScrollMemory(): void {
  memory.clear()
}
