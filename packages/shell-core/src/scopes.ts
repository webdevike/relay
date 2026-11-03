export type Scope = 'overlay' | 'terminal' | 'page' | 'global'
export const SCOPE_ORDER: readonly Scope[] = ['overlay', 'terminal', 'page', 'global']

export type HandlerResult = 'consumed' | 'yield' | false
export type ScopeHandler = (chord: string) => HandlerResult

export interface Dispatch {
  result: 'consumed' | 'yield' | 'unhandled'
  scope?: Scope
}

export interface Scopes {
  register(scope: Scope, chord: string, handler: ScopeHandler): () => void
  dispatch(chord: string): Dispatch
}

export function createScopes(): Scopes {
  const entries: Record<Scope, Array<{ chord: string; handler: ScopeHandler }>> = {
    overlay: [],
    terminal: [],
    page: [],
    global: [],
  }
  return {
    register(scope, chord, handler) {
      const entry = { chord, handler }
      entries[scope].push(entry)
      return () => {
        const i = entries[scope].indexOf(entry)
        if (i >= 0) entries[scope].splice(i, 1)
      }
    },
    dispatch(chord) {
      for (const scope of SCOPE_ORDER) {
        const list = entries[scope]
        for (let i = list.length - 1; i >= 0; i--) {
          const e = list[i]!
          if (e.chord !== '*' && e.chord !== chord) continue
          const r = e.handler(chord)
          if (r) return { result: r, scope }
        }
      }
      return { result: 'unhandled' }
    },
  }
}

/** Terminal scope handler: yields every chord except the pass-through list. */
export function terminalClaim(passThrough: readonly string[]): ScopeHandler {
  return (chord) => (passThrough.includes(chord) ? false : 'yield')
}
