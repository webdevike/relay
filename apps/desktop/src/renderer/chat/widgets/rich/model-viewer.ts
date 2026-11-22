import { useEffect, useRef, useState, type RefObject } from 'react'
import { useActorRef, useSelector } from '@xstate/react'
import { fromCallback, fromPromise, type ActorRefFrom, type SnapshotFrom } from 'xstate'
import { MODEL_MAX_BYTES } from '@evaos/chat-core/model-limit'
import { mediaUrl } from '../media-url'
import { useRenderFailure } from '../render-report'
import { modelViewerMachine, type ModelInfo, type ModelViewerEvent } from './model-viewer.machine'
import { claimOpenModel, releaseOpenModel } from './open-model'

/**
 * Runtime of one Model block (model-viewer.machine.ts): the size probe, the three.js scene, the
 * far-away watch and the app-wide rule that only one model is open (open-model.ts).
 */

/** An open model this far outside the visible chat closes (px). */
const AWAY_PX = 1200

export type ModelView = 'probing' | 'poster' | 'loading' | 'ready' | 'failed' | 'tooLarge'

const viewOf = (s: SnapshotFrom<typeof modelViewerMachine>): ModelView =>
  s.matches({ live: 'loading' })
    ? 'loading'
    : s.matches({ live: 'ready' })
      ? 'ready'
      : (s.value as Exclude<ModelView, 'loading' | 'ready'>)
const infoOf = (s: SnapshotFrom<typeof modelViewerMachine>) => s.context

export interface ModelViewer {
  /** Where the canvas goes. */
  host: RefObject<HTMLDivElement | null>
  /** The sized frame, watched for scrolling far away. */
  frame: RefObject<HTMLDivElement | null>
  view: ModelView
  size: number | null
  name: string | null
  error: string | null
  open: () => void
}

export function useModelViewer(src: string, autoRotate: boolean): ModelViewer {
  const host = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  // The latest reporter, so a bubble's context changing never reloads the model.
  const reportFailure = useRenderFailure()
  const report = useRef(reportFailure)
  report.current = reportFailure
  const self = useRef<ActorRefFrom<typeof modelViewerMachine> | null>(null)
  const [{ machine, close }] = useState(() => {
    const close = (): void => self.current?.send({ type: 'viewer.close' })
    const machine = modelViewerMachine.provide({
      actions: {
        claim: () => claimOpenModel(close),
        release: () => releaseOpenModel(close),
      },
      actors: {
        info: fromPromise<ModelInfo>(async ({ signal }) => {
          const res = await fetch(`relay-media://info/?src=${encodeURIComponent(src)}`, { signal })
          if (!res.ok) throw new Error(await res.text())
          return (await res.json()) as ModelInfo
        }),
        scene: fromCallback<ModelViewerEvent>(({ sendBack }) => {
          let stopped = false
          let dispose: (() => void) | null = null
          const fail = (message: string, detail?: string): void => {
            sendBack({ type: 'viewer.failed', message })
            report.current('model', src, detail ? `${message}: ${detail}` : message)
          }
          import('./model-scene')
            .then(({ mountModel }) => {
              const el = host.current
              if (stopped || !el) return
              dispose = mountModel(el, mediaUrl(src), {
                autoRotate,
                maxBytes: MODEL_MAX_BYTES,
                onLoad: () => sendBack({ type: 'viewer.loaded' }),
                onError: fail,
                onTooLarge: (size) => sendBack({ type: 'viewer.tooLarge', size }),
              })
            })
            .catch((err: unknown) => {
              if (!stopped) fail("Couldn't load model", `3D viewer failed to load: ${String(err)}`)
            })
          return () => {
            stopped = true
            dispose?.()
          }
        }),
        away: fromCallback<ModelViewerEvent>(({ sendBack }) => {
          const el = frame.current
          if (!el || typeof IntersectionObserver === 'undefined') return () => {}
          const observer = new IntersectionObserver(
            ([entry]) => {
              if (entry && !entry.isIntersecting) sendBack({ type: 'viewer.close' })
            },
            { rootMargin: `${AWAY_PX}px 0px`, scrollMargin: `${AWAY_PX}px 0px` },
          )
          observer.observe(el)
          return () => observer.disconnect()
        }),
      },
    })
    return { machine, close }
  })
  const actor = useActorRef(machine)
  self.current = actor
  // A stopped actor runs no exit actions: give up the open slot here too.
  useEffect(() => () => releaseOpenModel(close), [close])
  const view = useSelector(actor, viewOf)
  const { size, name, error } = useSelector(actor, infoOf)
  const [open] = useState(() => () => actor.send({ type: 'viewer.open' }))
  return { host, frame, view, size, name, error, open }
}
