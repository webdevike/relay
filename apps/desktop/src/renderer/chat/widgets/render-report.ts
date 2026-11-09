import { createContext, useCallback, useContext } from 'react'
import type { RenderForm, RenderKind } from '@evaos/contract'
import { invoke } from '../../ipc'

/**
 * Media that fails to show in a reply is told to the host, which tells the owning agent so it
 * reposts a form that renders (agents never see the client). Only a chat bubble reports: a
 * dashboard tile, a canvas card or a user row has no agent to tell.
 */

/** The bubble media sits in: its reaction thread and reaction key (same on every device). */
export interface RenderMessageValue {
  thread: string
  message: string
}

/** Provided per assistant bubble that has a thread and a key; null everywhere else. */
export const RenderMessage = createContext<RenderMessageValue | null>(null)

/** How the agent wrote the media: a markdown embed unless an openui or ```ui block says so. */
export const RenderFormScope = createContext<RenderForm>('markdown')

/** thread|message|src already reported this app run, so a remount or re-render never repeats. */
const reported = new Set<string>()

/** Test hook: forget what was reported. */
export function clearRenderReports(): void {
  reported.clear()
}

const MEDIA_ERRORS = [
  '',
  'MEDIA_ERR_ABORTED',
  'MEDIA_ERR_NETWORK',
  'MEDIA_ERR_DECODE',
  'MEDIA_ERR_SRC_NOT_SUPPORTED',
]

/** `video error: MEDIA_ERR_SRC_NOT_SUPPORTED` from a failed <video>/<audio>, for the agent. */
export function mediaErrorText(label: 'video' | 'audio', el: HTMLMediaElement): string {
  const code = el.error?.code ?? 0
  const name = MEDIA_ERRORS[code] || 'unknown'
  const detail = el.error?.message ? ` (${el.error.message})` : ''
  return `${label} error: ${name}${detail}`
}

/**
 * `(kind, src, error)` reports one failure of `src` (as the agent wrote it, not the resolved URL);
 * a no-op outside a chat bubble. Fire and forget: main drops it when the host can't take it.
 */
export function useRenderFailure(): (kind: RenderKind, src: string, error: string) => void {
  const at = useContext(RenderMessage)
  const form = useContext(RenderFormScope)
  return useCallback(
    (kind, src, error) => {
      if (at === null || src === '') return
      const key = `${at.thread}|${at.message}|${src}`
      if (reported.has(key)) return
      reported.add(key)
      void invoke('render.failed', {
        thread: at.thread,
        message: at.message,
        kind,
        form,
        src: src.slice(0, 2048),
        error: error.slice(0, 300),
      }).catch(() => undefined)
    },
    [at, form],
  )
}
