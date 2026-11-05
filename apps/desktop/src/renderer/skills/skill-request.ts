/**
 * A skill another surface (a `relay://open/skills?skill=<name>` link) asked the Skills page to
 * select. A mounted page takes it at once; otherwise it waits for the page's first render.
 */
let pending: string | null = null
let listener: ((name: string) => void) | null = null

export function requestSkill(name: string): void {
  if (listener) listener(name)
  else pending = name
}

export function takeSkillRequest(): string | null {
  const name = pending
  pending = null
  return name
}

export function onSkillRequest(fn: (name: string) => void): () => void {
  listener = fn
  return () => {
    if (listener === fn) listener = null
  }
}
