import { useEffect, useReducer } from 'react'
import type * as Y from 'yjs'

/** The map's entries, re-read whenever anyone (the host, another editor) changes it. */
export function useYMap(map: Y.Map<unknown>): Record<string, unknown> {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    map.observe(bump)
    return () => map.unobserve(bump)
  }, [map])
  return map.toJSON()
}
