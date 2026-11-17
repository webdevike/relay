import { useCallback, useEffect, useRef, useState } from 'react'
import type { LaunchPatch, LaunchState } from '@evaos/contract'
import type { ModelInfo } from '@evaos/chat-core/launch'
import { invoke } from '../../ipc'
import { useChatStore } from '../chat-store'

/** Waits before each retry of a failed model-catalog load; the catalog itself never caches a failure. */
const MODEL_RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const

const isLaunchState = (v: unknown): v is LaunchState =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as LaunchState).approval === 'string' &&
  typeof (v as LaunchState).unsent === 'boolean'

export interface LaunchControls {
  state: LaunchState | null
  models: readonly ModelInfo[]
  /** omp's configured default thinking level (the picker's reset target), or null. */
  defaultThinking: string | null
  /** A change is in flight (an access restart takes a moment). */
  busy: boolean
  /** Main's message for the last refused change, shown under the toolbar. */
  error: string | null
  apply(patch: LaunchPatch): Promise<void>
  clearError(): void
}

/**
 * The toolbar's state for one pane: what main says is chosen, the model catalog, and a single
 * way to change it. Reloads when the pane's model, thinking level, file or process state moves.
 */
export function useLaunchState(paneId: string, enabled: boolean): LaunchControls {
  const [state, setState] = useState<LaunchState | null>(null)
  const [models, setModels] = useState<readonly ModelInfo[]>([])
  const [defaultThinking, setDefaultThinking] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const model = useChatStore((s) => s.panes[paneId]?.meta.model ?? null)
  const thinking = useChatStore((s) => s.panes[paneId]?.thinking ?? null)
  const stopped = useChatStore((s) => s.panes[paneId]?.stopped ?? false)
  const file = useChatStore((s) => s.panes[paneId]?.file ?? '')
  const key = `${model ? model.join('/') : ''}|${thinking ?? ''}|${stopped}|${file}`

  useEffect(() => {
    if (!enabled) {
      setState(null)
      return
    }
    let stale = false
    void invoke('chat.launchState', { paneId }).then((r) => {
      if (!stale && alive.current && r.ok && isLaunchState(r.value)) setState(r.value)
    })
    return () => {
      stale = true
    }
  }, [paneId, enabled, key])

  useEffect(() => {
    if (!enabled) return
    let stale = false
    let timer: number | undefined
    const load = (attempt: number): void => {
      void invoke('chat.models', {}).then((r) => {
        if (stale || !alive.current) return
        if (r.ok && Array.isArray(r.value?.models)) {
          setModels(r.value.models)
          setDefaultThinking(typeof r.value.thinking === 'string' ? r.value.thinking : null)
          return
        }
        // A failed load (omp slow or briefly unavailable) leaves the picker on raw ids: try again.
        if (attempt < MODEL_RETRY_MS.length) {
          timer = window.setTimeout(() => load(attempt + 1), MODEL_RETRY_MS[attempt])
        }
      })
    }
    load(0)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [enabled])

  const apply = useCallback(
    async (patch: LaunchPatch): Promise<void> => {
      setBusy(true)
      setError(null)
      const r = await invoke('chat.setLaunch', { paneId, patch })
      if (!alive.current) return
      setBusy(false)
      if (r.ok && isLaunchState(r.value)) setState(r.value)
      else if (!r.ok) setError(r.error.message)
    },
    [paneId],
  )

  return {
    state,
    models,
    defaultThinking,
    busy,
    error,
    apply,
    clearError: () => setError(null),
  }
}
