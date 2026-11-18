/**
 * How each node type draws, from its board-file spec (native canvas_view/cards.rs). Sizes are flow
 * units (pixels at zoom 1); colors are theme roles, so light and dark both follow the theme.
 */
import { ActionIcon, Tooltip } from '@mantine/core'
import {
  IconExternalLink,
  IconFrame,
  IconGitPullRequest,
  IconLayoutKanban,
  IconMaximize,
  IconLink,
  IconNote,
  IconPhoto,
  IconSparkles,
  IconTimeline,
} from '@tabler/icons-react'
import {
  Handle,
  NodeResizer,
  Position,
  useStore as useFlowStore,
  type NodeProps,
} from '@xyflow/react'
import { memo, useEffect, useRef, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import type { CanvasNode } from '@evaos/contract'
import { liveQuery } from '../../boards/live-query'
import { OpenUIQuery } from '../../chat/widgets/actions'
import { OpenUIBlock } from '../../chat/widgets/Widget'
import { openLink } from '../../navigation/open-link'
import { sendCardGen, useCardGen } from '../agent/card-gen'
import { useBoardActions } from '../context'
import type { CardNode } from '../flow-model'
import { GenGlow, GenLabel, quietGen } from './CardGen'
import { Markdown } from '../../chat/markdown/Markdown'
import { useCanvasImage } from './canvas-image'
import { MermaidBlock } from './MermaidBlock'
import { ProtoCard } from './ProtoCard'
import { stepIcon } from './step-icons'
import { Wireframe } from './Wireframe'

const TONES = ['neutral', 'accent', 'warn', 'danger', 'success', 'muted'] as const
type Tone = (typeof TONES)[number]

/** A color role by name, else `fallback`. */
function tone(name: string | undefined, fallback: Tone): Tone {
  return TONES.find((t) => t === name) ?? fallback
}

/** A link's host for its button, `dribbble.com` for `https://dribbble.com/shots/…`. */
export function host(url: string): string {
  const rest = url.includes('://') ? url.split('://')[1]! : url
  const h = rest.split('/')[0] ?? rest
  return h.startsWith('www.') ? h.slice(4) : h
}

/** `#RRGGBB` or `#RRGGBBAA`, else null. */
export function swatchColor(hex: string): string | null {
  const digits = hex.trim().replace(/^#/, '')
  return /^([0-9a-f]{6}|[0-9a-f]{8})$/i.test(digits) ? `#${digits}` : null
}

const stop = (e: MouseEvent): void => e.stopPropagation()

/** A small "↗ host" link that opens `url` in the side browser; its press stays off the card. */
function LinkRow({ id, url }: { id: string; url: string }) {
  return (
    <button
      type="button"
      className="eva-cv-link nodrag nopan"
      data-testid={`canvas-link-${id}`}
      title={url}
      onPointerDown={stop}
      onClick={(e) => {
        e.stopPropagation()
        openLink(url)
      }}
    >
      <IconExternalLink size={12} stroke={1.75} aria-hidden />
      <span>{host(url)}</span>
    </button>
  )
}

/**
 * An image card's picture: the original file (never a thumbnail) so the board stays sharp when
 * zoomed in, with an "Open full size" button on hover.
 */
function Picture({ id, spec, inner }: { id: string; spec: CanvasNode; inner: number }) {
  const { slug, openImage } = useBoardActions()
  const src = spec.data?.src
  const image = useCanvasImage(slug, src)
  const fallback = inner * 0.75
  if (image?.state === 'ready') {
    return (
      <div className="eva-cv-picture-wrap">
        <img
          className="eva-cv-picture"
          src={image.dataUrl}
          alt={spec.data?.title ?? ''}
          draggable={false}
          style={{ height: image.ratio ? inner * image.ratio : fallback }}
        />
        <Tooltip label="Open full size" openDelay={400}>
          <ActionIcon
            variant="default"
            size={24}
            className="eva-cv-picture-open nodrag nopan"
            aria-label="Open full size"
            data-testid={`canvas-image-open-${id}`}
            onPointerDown={stop}
            onDoubleClick={stop}
            onClick={(e) => {
              e.stopPropagation()
              openImage(id)
            }}
          >
            <IconMaximize size={14} stroke={1.75} />
          </ActionIcon>
        </Tooltip>
      </div>
    )
  }
  const text = !src ? 'No src' : image?.state === 'failed' ? image.message : 'Loading'
  return (
    <div className="eva-cv-picture eva-cv-picture-note" style={{ height: fallback }}>
      <IconPhoto size={14} stroke={1.5} aria-hidden />
      <span>{text}</span>
    </div>
  )
}

function Swatches({ spec }: { spec: CanvasNode }) {
  return (
    <div className="eva-cv-swatches">
      {(spec.data?.colors ?? []).map((s, i) => (
        <div key={`${s.hex}-${i}`} className="eva-cv-swatch">
          <span
            className="eva-cv-swatch-chip"
            style={{ background: swatchColor(s.hex) ?? 'var(--eva-c-muted-foreground)' }}
          />
          {s.name !== undefined ? <span className="eva-cv-swatch-name">{s.name}</span> : null}
          <span className="eva-cv-swatch-hex">{s.hex.toUpperCase()}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * A frame (or a lane): its title, a wireframe while it is empty, and while an agent makes it
 * (agent/card-gen.machine.ts) the generation label in place of the title and the frame's light.
 * Its first card arriving is its content drawing; a card landing in it (or one in it streaming,
 * ProtoCard) is content streaming in.
 */
function FrameBody({
  id,
  spec,
  hasChildren,
}: {
  id: string
  spec: CanvasNode
  hasChildren: boolean
}) {
  const { slug } = useBoardActions()
  const gen = useCardGen(slug, id)
  const creating = gen === 'creating'
  useEffect(() => {
    if (hasChildren) sendCardGen(slug, id, { type: 'card.drawn' })
  }, [slug, id, hasChildren, creating])
  const kids = useFlowStore((s) => s.parentLookup.get(id)?.size ?? 0)
  const kidsBefore = useRef(kids)
  useEffect(() => {
    if (kids > kidsBefore.current) sendCardGen(slug, id, { type: 'card.revealed', ms: 0 })
    kidsBefore.current = kids
  }, [slug, id, kids])
  const d = spec.data ?? {}
  const title = d.title ?? ''
  const label = quietGen(gen) ? null : (
    <GenLabel id={id} slug={slug} state={gen} title={title || 'Frame'} />
  )
  const glow = <GenGlow state={gen} empty={!hasChildren} />
  if (d.variant === 'lane')
    return (
      <>
        <div className="eva-cv-lane-head">
          {label ?? <span className="eva-cv-lane-title">{title}</span>}
          {d.body !== undefined ? <span className="eva-cv-lane-caption">{d.body}</span> : null}
        </div>
        {glow}
      </>
    )
  return (
    <>
      <div className="eva-cv-frame-title">
        {label ?? (
          <>
            <IconFrame size={12} stroke={1.75} aria-hidden />
            <span>{title}</span>
          </>
        )}
      </div>
      {!hasChildren && d.url !== undefined ? <Wireframe url={d.url} /> : null}
      {glow}
    </>
  )
}

function Specimen({ spec }: { spec: CanvasNode }) {
  const d = spec.data ?? {}
  const family = d.font
  const font: CSSProperties = family ? { fontFamily: `"${family}", var(--eva-font-ui)` } : {}
  return (
    <>
      <div className="eva-cv-small">{d.title || 'Type'}</div>
      <div className="eva-cv-type-head" style={font}>
        <span className="eva-cv-type-aa">Aa</span>
        <span className="eva-cv-type-family">{family ?? 'Theme font'}</span>
      </div>
      {(['Regular', 'Medium', 'Semibold'] as const).map((w, i) => (
        <div key={w} className="eva-cv-type-weight" style={{ ...font, fontWeight: 400 + i * 100 }}>
          {w}
        </div>
      ))}
      {d.sample !== undefined ? (
        <div className="eva-cv-type-sample" style={font}>
          {d.sample}
        </div>
      ) : null}
    </>
  )
}

function SuggestionButtons({ id }: { id: string }) {
  const { acceptSuggestion, removeNode } = useBoardActions()
  return (
    <div className="eva-cv-suggest-actions">
      <button
        type="button"
        className="eva-cv-pill-btn nodrag nopan"
        data-variant="accent"
        data-testid="canvas-suggestion-add"
        onPointerDown={stop}
        onClick={(e) => {
          e.stopPropagation()
          acceptSuggestion(id)
        }}
      >
        Add branch
      </button>
      <button
        type="button"
        className="eva-cv-pill-btn nodrag nopan"
        data-testid="canvas-suggestion-dismiss"
        onPointerDown={stop}
        onClick={(e) => {
          e.stopPropagation()
          removeNode(id)
        }}
      >
        Dismiss
      </button>
    </div>
  )
}

/** A `step` card: number badge and icon, bold title, a short body, an optional status pill. */
function StepBody({ spec }: { spec: CanvasNode }) {
  const d = spec.data ?? {}
  const Icon = stepIcon(d.icon)
  return (
    <>
      <div className="eva-cv-step-head">
        {d.step !== undefined ? (
          <span className="eva-cv-step-badge" data-tone={tone(d.tone, 'accent')}>
            {d.step}
          </span>
        ) : null}
        <Icon className="eva-cv-step-icon" size={16} stroke={1.75} aria-hidden />
        {d.status !== undefined ? (
          <span className="eva-cv-status eva-cv-step-status" data-tone={tone(d.tone, 'muted')}>
            {d.status}
          </span>
        ) : null}
      </div>
      <div className="eva-cv-step-title">{d.title ?? ''}</div>
      {d.body !== undefined ? <div className="eva-cv-step-body">{d.body}</div> : null}
    </>
  )
}

/** An `explainer` card: title, markdown body, optional picture and diagram, a "Why it matters" band. */
function ExplainerBody({ spec }: { spec: CanvasNode }) {
  const { slug } = useBoardActions()
  const d = spec.data ?? {}
  const image = useCanvasImage(slug, d.src)
  return (
    <>
      <div className="eva-cv-explainer-title">{d.title ?? ''}</div>
      {/* Selectable text: its pointer and wheel stay off the board's drag and pan. */}
      <div
        className="eva-cv-explainer-body nodrag nopan nowheel"
        onPointerDown={stop}
        onDoubleClick={stop}
      >
        {d.body !== undefined ? <Markdown text={d.body} /> : null}
      </div>
      {d.src !== undefined && image?.state === 'ready' ? (
        <img
          className="eva-cv-explainer-image"
          src={image.dataUrl}
          alt={d.title ?? ''}
          draggable={false}
        />
      ) : null}
      {d.mermaid !== undefined ? <MermaidBlock source={d.mermaid} /> : null}
      {d.why !== undefined ? (
        <div
          className="eva-cv-explainer-why nodrag nopan nowheel"
          onPointerDown={stop}
          onDoubleClick={stop}
        >
          <div className="eva-cv-explainer-why-label">Why it matters</div>
          <Markdown text={d.why} />
        </div>
      ) : null}
    </>
  )
}

function Body({ id, spec, hasChildren }: { id: string; spec: CanvasNode; hasChildren: boolean }) {
  const d = spec.data ?? {}
  const title = d.title ?? ''
  const link = d.url !== undefined ? <LinkRow id={id} url={d.url} /> : null
  switch (spec.type) {
    case 'step':
      return <StepBody spec={spec} />
    case 'explainer':
      return <ExplainerBody spec={spec} />
    case 'topic':
      return (
        <>
          <div className="eva-cv-topic-label">Topic</div>
          <div className="eva-cv-topic-title">{title}</div>
          {d.body !== undefined ? <div className="eva-cv-topic-body">{d.body}</div> : null}
        </>
      )
    case 'note':
      return (
        <>
          {title !== '' ? (
            <div className="eva-cv-note-title">
              <IconNote size={14} stroke={1.75} aria-hidden />
              <span>{title}</span>
            </div>
          ) : null}
          {d.body !== undefined ? <div className="eva-cv-note-body">{d.body}</div> : null}
        </>
      )
    case 'ticket':
      return (
        <>
          <div className="eva-cv-ticket-head">
            <IconLayoutKanban size={12} stroke={1.75} aria-hidden />
            <span className="eva-cv-ticket-key">{d.key ?? ''}</span>
            {d.status !== undefined ? (
              <span className="eva-cv-status" data-tone={tone(d.tone, 'accent')}>
                {d.status}
              </span>
            ) : null}
          </div>
          <div className="eva-cv-heading">{title}</div>
          {d.pr !== undefined ? (
            <div className="eva-cv-meta">
              <IconGitPullRequest size={12} stroke={1.75} aria-hidden />
              <span>{d.pr}</span>
            </div>
          ) : null}
          {link}
        </>
      )
    case 'image':
      return (
        <>
          <Picture id={id} spec={spec} inner={(spec.w ?? 240) - 20} />
          {title !== '' ? <div className="eva-cv-heading eva-cv-pad">{title}</div> : null}
          {d.caption !== undefined ? (
            <div className="eva-cv-small eva-cv-pad">{d.caption}</div>
          ) : null}
          {link ? <div className="eva-cv-pad">{link}</div> : null}
        </>
      )
    case 'link':
      return (
        <>
          <div className="eva-cv-link-head">
            <IconLink size={14} stroke={1.75} aria-hidden />
            <span className="eva-cv-heading">{title || d.url || ''}</span>
          </div>
          {d.caption !== undefined ? <div className="eva-cv-small">{d.caption}</div> : null}
          {link}
        </>
      )
    case 'frame':
      return <FrameBody id={id} spec={spec} hasChildren={hasChildren} />
    case 'suggestion':
      return (
        <>
          <div className="eva-cv-suggest-title">
            <IconSparkles size={14} stroke={1.75} aria-hidden />
            <span>{title}</span>
          </div>
          {d.body !== undefined ? <div className="eva-cv-small">{d.body}</div> : null}
          <SuggestionButtons id={id} />
        </>
      )
    case 'palette':
      return (
        <>
          <div className="eva-cv-small">{title || 'Palette'}</div>
          <Swatches spec={spec} />
        </>
      )
    case 'typography':
      return <Specimen spec={spec} />
    case 'ui':
      return (
        <>
          <div className="eva-cv-ui-title">
            <IconTimeline size={12} stroke={1.75} aria-hidden />
            <span>{title || 'Live widget'}</span>
          </div>
          {/* Its own pointer and wheel: buttons, inputs and scrolling stay off the board's pan and drag. */}
          <div
            className="eva-cv-ui-body nodrag nopan nowheel"
            data-testid={`canvas-ui-${id}`}
            onPointerDown={stop}
            onDoubleClick={stop}
          >
            <OpenUIQuery.Provider value={liveQuery}>
              <OpenUIBlock code={d.body ?? ''} closed />
            </OpenUIQuery.Provider>
          </div>
        </>
      )
    case 'proto':
      return <ProtoCard id={id} spec={spec} />
  }
}

const SIDES = [
  ['left', Position.Left],
  ['top', Position.Top],
  ['right', Position.Right],
  ['bottom', Position.Bottom],
] as const

/** A handle on every side, ids named by side; any side can start or end a link. */
function Handles(): ReactNode {
  return SIDES.map(([id, position]) => (
    <Handle key={id} id={id} type="source" position={position} className="eva-cv-handle" />
  ))
}

/** One node, drawn by its type from its spec. */
export const CanvasCard = memo(function CanvasCard({ id, data, selected }: NodeProps<CardNode>) {
  const { spec, hasChildren } = data
  const kind = spec.type
  const t =
    kind === 'note'
      ? tone(spec.data?.tone, 'warn')
      : kind === 'ticket'
        ? tone(spec.data?.tone, 'accent')
        : kind === 'step' || kind === 'explainer' || kind === 'frame'
          ? tone(spec.data?.tone, 'neutral')
          : undefined
  const lane = kind === 'frame' && spec.data?.variant === 'lane' ? 'lane' : undefined
  return (
    <div
      className="eva-cv-card"
      data-kind={kind}
      data-variant={lane}
      data-tone={t}
      data-selected={selected ? 'true' : undefined}
      data-testid={`canvas-card-${id}`}
      style={
        spec.h !== undefined || kind === 'frame' || kind === 'ui' || kind === 'proto'
          ? { height: '100%' }
          : undefined
      }
    >
      {/* A component card is sized by its frame (its header picks it), so only widgets resize. */}
      {kind === 'ui' ? <NodeResizer isVisible={selected} minWidth={240} minHeight={140} /> : null}
      <Body id={id} spec={spec} hasChildren={hasChildren} />
      <Handles />
    </div>
  )
})
