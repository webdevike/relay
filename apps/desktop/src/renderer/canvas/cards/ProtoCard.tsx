/**
 * A prototype or component card (the design canvas): an artboard. Its frame is the real Relay
 * surface it is designed for (`data.frame`: a page, the chat column, the chip strip, a phone...)
 * and the card draws its page at exactly that size, 1:1 and clipped, never stretched, so the board
 * shows what ships; zooming the board scales the whole frame. A quiet header names the variant,
 * the title, the frame and its size (a picker: presets or a custom size), whether a new revision
 * is drawing, and a Pick button in a variant set. Content that does not fit says by how much. The
 * page boots once and takes every later edit of the code in place (proto-frame.machine.ts), so an
 * agent's edit redraws within a moment and a broken edit leaves the last good render on screen.
 */
import { Tooltip } from '@mantine/core'
import { IconAlertTriangle, IconHandFinger, IconTemplate } from '@tabler/icons-react'
import { useActorRef, useSelector } from '@xstate/react'
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { SnapshotFrom } from 'xstate'
import { useStore } from 'zustand'
import type { CanvasNode } from '@evaos/contract'
import { liveSourceMessage, parseFrameMessage } from '@relay/widget-runtime/frame'
import type { ProtoAssistant } from '@relay/widget-runtime/proto'
import { frameOf } from '@relay/widget-runtime/systems'
import { useAssistants } from '../../assistants/assistants-store'
import { protoFrameUrl } from '../../chat/widgets/frame-theme'
import { themeStore, useColorScheme } from '../../theme/theme-config'
import { useBoardActions } from '../context'
import { protoFrameMachine } from './proto-frame.machine'
import { ProtoFramePicker } from './ProtoFramePicker'

const stop = (e: MouseEvent): void => e.stopPropagation()

type ProtoSnapshot = SnapshotFrom<typeof protoFrameMachine>

const selectPhase = (s: ProtoSnapshot): string =>
  s.hasTag('busy') ? 'drawing' : s.hasTag('error') ? 'error' : 'live'
const selectBoot = (s: ProtoSnapshot): number => s.context.boot
const selectBootSource = (s: ProtoSnapshot): string => s.context.bootSource
const selectError = (s: ProtoSnapshot): string | null => s.context.error
const selectRev = (s: ProtoSnapshot): number => s.context.rev
const selectHasGood = (s: ProtoSnapshot): boolean => s.context.good !== null

/** How far the content runs past the frame, as the corner note says it. */
function overflowNote(content: { w: number; h: number } | null, w: number, h: number): string {
  if (content === null) return ''
  const parts: string[] = []
  if (content.h > h + 1) parts.push(`${String(content.h - h)}px below`)
  if (content.w > w + 1) parts.push(`${String(content.w - w)}px right`)
  return parts.length === 0 ? '' : `+${parts.join(', ')}`
}

export function ProtoCard({ id, spec }: { id: string; spec: CanvasNode }) {
  const scheme = useColorScheme()
  const config = useStore(themeStore, (s) => s.present)
  const { pickVariant, setFrame } = useBoardActions()
  const d = spec.data ?? {}
  const system = d.system ?? 'mantine'
  const source = d.body ?? ''
  const frame = frameOf(d.frame)
  // The relay system draws in the app's own Settings > Theme, with the real assistant registry.
  const themeConfig = system === 'relay' ? config : undefined
  const agents = useAssistants((s) => s.data?.agents)
  const registry = useMemo(() => {
    if (system !== 'relay' || agents === undefined) return undefined
    const out: Record<string, ProtoAssistant> = {}
    for (const a of agents) out[a.id] = { title: a.title, avatar: a.avatar }
    return out
  }, [system, agents])

  const page = useRef<HTMLIFrameElement>(null)
  const machine = useMemo(
    () =>
      protoFrameMachine.provide({
        actions: {
          post: ({ context }) =>
            page.current?.contentWindow?.postMessage(
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

  // A new theme, scheme, design system or registry boots a fresh page (from the last good code).
  const look = `${system}|${scheme}|${themeConfig ? JSON.stringify(themeConfig) : ''}|${registry ? JSON.stringify(registry) : ''}`
  const lookRef = useRef(look)
  useEffect(() => {
    if (lookRef.current === look) return
    lookRef.current = look
    actor.send({ type: 'frame.reboot' })
  }, [actor, look])

  // The page's content size, which the frame clips; a new page reports its own.
  const [content, setContent] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => setContent(null), [boot])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!page.current || event.source !== page.current.contentWindow) return
      const message = parseFrameMessage(event.data)
      if (message?.type === 'render') {
        actor.send({
          type: 'frame.rendered',
          rev: message.rev,
          ok: message.ok,
          error: message.error,
        })
      } else if (message?.type === 'content') {
        setContent({ w: Math.round(message.w), h: Math.round(message.h) })
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [actor])

  // The page's URL changes only when it boots (`boot` bumps on every boot, with the look and
  // code of that moment): later code goes to the running page as messages.
  const url = useMemo(
    () =>
      protoFrameUrl(bootSource, system, scheme, {
        config: themeConfig,
        assistants: registry,
        live: true,
      }),
    [boot],
  )
  const title = d.title || 'Prototype'
  const label = d.variant
  const overflow = overflowNote(content, frame.w, frame.h)

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
        {phase === 'drawing' && hasGood ? (
          <span className="eva-cv-proto-meta" data-testid={`canvas-proto-drawing-${id}`}>
            Redrawing
          </span>
        ) : null}
        <ProtoFramePicker id={id} frame={frame} onPick={(f) => setFrame(id, f)} />
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
      <div
        className="eva-cv-proto-body nodrag nopan nowheel"
        data-testid={`canvas-proto-${id}`}
        data-frame={frame.preset}
        data-phase={phase}
        data-rev={rev}
        data-boot={boot}
        data-overflow={overflow === '' ? undefined : 'true'}
        style={{ width: frame.w, height: frame.h }}
        onPointerDown={stop}
        onDoubleClick={stop}
      >
        <iframe
          key={boot}
          ref={page}
          className="eva-cv-proto-frame"
          title={title}
          src={url}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          width={frame.w}
          height={frame.h}
        />
        {overflow !== '' ? (
          <span className="eva-cv-proto-overflow" data-testid={`canvas-proto-overflow-${id}`}>
            {overflow}
          </span>
        ) : null}
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
      </div>
    </>
  )
}
