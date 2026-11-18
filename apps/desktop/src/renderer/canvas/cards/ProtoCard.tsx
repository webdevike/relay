/**
 * A prototype or component card (the design canvas): a quiet header (its variant label, title,
 * screen width, whether a new revision is drawing, a Pick button in a variant set), the page that
 * draws its JSX in its design system, and why the newest code did not draw. The page boots once
 * and takes every later edit of the code in place (proto-frame.machine.ts), so an agent's edit
 * redraws within a moment and a broken edit leaves the last good render on screen.
 */
import { Tooltip } from '@mantine/core'
import { IconAlertTriangle, IconHandFinger, IconTemplate } from '@tabler/icons-react'
import { useActorRef, useSelector } from '@xstate/react'
import { useEffect, useMemo, useRef, type MouseEvent } from 'react'
import type { SnapshotFrom } from 'xstate'
import { useStore } from 'zustand'
import type { CanvasNode } from '@evaos/contract'
import { liveSourceMessage, parseFrameMessage } from '@relay/widget-runtime/frame'
import { viewportWidth } from '@relay/widget-runtime/systems'
import { protoFrameUrl } from '../../chat/widgets/frame-theme'
import { themeStore, useColorScheme } from '../../theme/theme-config'
import { useBoardActions } from '../context'
import { protoFrameMachine } from './proto-frame.machine'

const stop = (e: MouseEvent): void => e.stopPropagation()

type ProtoSnapshot = SnapshotFrom<typeof protoFrameMachine>

const selectPhase = (s: ProtoSnapshot): string =>
  s.hasTag('busy') ? 'drawing' : s.hasTag('error') ? 'error' : 'live'
const selectBoot = (s: ProtoSnapshot): number => s.context.boot
const selectBootSource = (s: ProtoSnapshot): string => s.context.bootSource
const selectError = (s: ProtoSnapshot): string | null => s.context.error
const selectRev = (s: ProtoSnapshot): number => s.context.rev
const selectHasGood = (s: ProtoSnapshot): boolean => s.context.good !== null

export function ProtoCard({ id, spec }: { id: string; spec: CanvasNode }) {
  const scheme = useColorScheme()
  const config = useStore(themeStore, (s) => s.present)
  const { pickVariant } = useBoardActions()
  const d = spec.data ?? {}
  const system = d.system ?? 'mantine'
  const source = d.body ?? ''
  const column = viewportWidth(d.viewport)
  // The relay system draws in the app's own Settings > Theme.
  const themeConfig = system === 'relay' ? config : undefined

  const frame = useRef<HTMLIFrameElement>(null)
  const machine = useMemo(
    () =>
      protoFrameMachine.provide({
        actions: {
          post: ({ context }) =>
            frame.current?.contentWindow?.postMessage(
              liveSourceMessage(context.latest, context.rev),
              '*',
            ),
        },
      }),
    [],
  )
  const actor = useActorRef(machine, { input: { source } })
  const phase = useSelector(actor, selectPhase)
  const boot = useSelector(actor, selectBoot)
  const bootSource = useSelector(actor, selectBootSource)
  const error = useSelector(actor, selectError)
  const rev = useSelector(actor, selectRev)
  const hasGood = useSelector(actor, selectHasGood)

  useEffect(() => actor.send({ type: 'source.changed', source }), [actor, source])

  // A new theme, scheme or design system boots a fresh page (from the last good code).
  const look = `${system}|${scheme}|${themeConfig ? JSON.stringify(themeConfig) : ''}`
  const lookRef = useRef(look)
  useEffect(() => {
    if (lookRef.current === look) return
    lookRef.current = look
    actor.send({ type: 'frame.reboot' })
  }, [actor, look])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const message = parseFrameMessage(event.data)
      if (message?.type === 'render') {
        actor.send({
          type: 'frame.rendered',
          rev: message.rev,
          ok: message.ok,
          error: message.error,
        })
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [actor])

  // The page's URL changes only when it boots (`boot` bumps on every boot, with the look and
  // code of that moment): later code goes to the running page as messages.
  const url = useMemo(
    () => protoFrameUrl(bootSource, system, scheme, { config: themeConfig, live: true }),
    [boot],
  )
  const title = d.title || 'Prototype'
  const label = d.variant

  return (
    <>
      <div className="eva-cv-ui-title eva-cv-proto-head">
        {label !== undefined ? (
          <span className="eva-cv-proto-label" data-testid={`canvas-proto-label-${id}`}>
            {label}
          </span>
        ) : (
          <IconTemplate size={12} stroke={1.75} aria-hidden />
        )}
        <span className="eva-cv-proto-title">{title}</span>
        {column !== undefined ? <span className="eva-cv-proto-meta">{column}px</span> : null}
        {phase === 'drawing' && hasGood ? (
          <span className="eva-cv-proto-meta" data-testid={`canvas-proto-drawing-${id}`}>
            Redrawing
          </span>
        ) : null}
        {d.group !== undefined ? (
          <Tooltip label="Pick this variant: tells the chat working on the board" openDelay={400}>
            <button
              type="button"
              className="eva-cv-pill-btn nodrag nopan eva-cv-proto-pick"
              data-testid={`canvas-proto-pick-${id}`}
              onPointerDown={stop}
              onClick={(e) => {
                e.stopPropagation()
                pickVariant(id)
              }}
            >
              <IconHandFinger size={12} stroke={1.75} aria-hidden />
              Pick
            </button>
          </Tooltip>
        ) : null}
      </div>
      {error !== null && phase === 'error' ? (
        <div
          className="eva-cv-proto-error"
          role="status"
          title={error}
          data-testid={`canvas-proto-error-${id}`}
        >
          <IconAlertTriangle size={12} stroke={1.75} aria-hidden />
          <span className="eva-cv-proto-error-text">{error}</span>
          {hasGood ? (
            <span className="eva-cv-proto-error-keep">Showing the last good render</span>
          ) : null}
        </div>
      ) : null}
      <div
        className="eva-cv-proto-body nodrag nopan nowheel"
        data-testid={`canvas-proto-${id}`}
        data-viewport={column === undefined ? 'desktop' : (d.viewport ?? 'desktop')}
        data-phase={phase}
        data-rev={rev}
        data-boot={boot}
        onPointerDown={stop}
        onDoubleClick={stop}
      >
        <iframe
          key={boot}
          ref={frame}
          className="eva-cv-proto-frame"
          title={title}
          src={url}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          style={column === undefined ? undefined : { width: column }}
        />
      </div>
    </>
  )
}
