import { useState } from 'react'
import { createPortal } from 'react-dom'
import { IconPhotoOff } from '@tabler/icons-react'
import { Markdown } from '../../chat/markdown/Markdown'
import { mediaUrl } from '../../chat/widgets/media-url'
import type { AgentMark } from '../presence-store'
import type { BlockSlot } from './live-preview'
import { frontmatterRows, type Block } from './md-layout'

// The rendered form of the blocks live-preview.ts draws over their hidden lines: a table, a
// standalone image, the frontmatter as properties. A click puts the caret in the block, which
// shows its lines for editing. An agent editing one outlines it in its color with its name tag.

/** Where an image in the file at `file` (absolute) loads from: a URL as is, a path from the file. */
function imageSrc(src: string, file: string): string {
  if (/^(https?:|data:)/i.test(src)) return src
  const clean = decodeURI(src.split(/[?#]/)[0] ?? src)
  const abs = clean.startsWith('/')
    ? clean
    : `${file.slice(0, file.lastIndexOf('/'))}/${clean}`
        .split('/')
        .reduce<string[]>((parts, p) => {
          if (p === '..') parts.pop()
          else if (p !== '.') parts.push(p)
          return parts
        }, [])
        .join('/')
  return mediaUrl(abs.startsWith('/') ? abs : `/${abs}`)
}

function Image({ block, file }: { block: Extract<Block, { kind: 'image' }>; file: string }) {
  const [failed, setFailed] = useState(false)
  if (failed)
    return (
      <span className="eva-md-image-missing">
        <IconPhotoOff size={16} stroke={1.5} />
        {block.alt || block.src}
      </span>
    )
  return <img src={imageSrc(block.src, file)} alt={block.alt} onError={() => setFailed(true)} />
}

function Properties({ source }: { source: string }) {
  return (
    <dl className="eva-md-props">
      {frontmatterRows(source).map((row, i) => (
        <div key={i} className="eva-md-prop">
          {row.key === null ? null : <dt>{row.key}</dt>}
          <dd data-wide={row.key === null || undefined}>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function AgentTag({ mark }: { mark: AgentMark }) {
  return (
    <span
      className="eva-agent-label eva-md-block-agent"
      data-testid={`agent-block-${mark.agent.name}`}
    >
      {mark.agent.avatarUrl ? (
        <img className="eva-agent-avatar" src={mark.agent.avatarUrl} alt="" />
      ) : null}
      {mark.agent.name}
      {mark.intent ? <span className="eva-agent-intent">{mark.intent}</span> : null}
    </span>
  )
}

function BlockView({ slot, file }: { slot: BlockSlot; file: string }) {
  const { block } = slot
  const who = slot.agents.at(-1)
  return (
    <div
      className="eva-md-block"
      data-kind={block.kind}
      data-agent={who ? '' : undefined}
      data-fading={who?.fading || undefined}
      data-testid={`md-block-${block.kind}`}
      style={who ? ({ '--who': who.agent.color } as React.CSSProperties) : undefined}
      title="Click to edit"
      onMouseDown={(e) => {
        // A link in a table opens with Cmd; any other click edits the block.
        if ((e.metaKey || e.ctrlKey) && (e.target as HTMLElement).closest('a')) return
        e.preventDefault()
        slot.open()
      }}
    >
      {who ? <AgentTag mark={who} /> : null}
      {block.kind === 'table' ? (
        <Markdown text={block.source} />
      ) : block.kind === 'image' ? (
        <Image block={block} file={file} />
      ) : (
        <Properties source={block.source} />
      )}
    </div>
  )
}

/** Portals each rendered block into its zone. `file` is the open file's absolute path. */
export function RenderedBlocks({ slots, file }: { slots: readonly BlockSlot[]; file: string }) {
  return <>{slots.map((s) => createPortal(<BlockView slot={s} file={file} />, s.el, s.key))}</>
}
