import { Avatar } from '@mantine/core'
import { IconBrandOpenai } from '@tabler/icons-react'
import { useState } from 'react'
import {
  COUNCIL_HARNESS_LABEL,
  COUNCIL_MODELS,
  COUNCIL_ROLE_LABEL,
  COUNCIL_THINKING_LABEL,
  type CouncilHarness,
  type CouncilModelKey,
  type CouncilProvider,
  type CouncilRole,
  type CouncilThinking,
} from '@relay/protocol'
import type { RoomRender } from '@evaos/contract'
import { IconAnthropic } from '../brand/ProviderIcon'
import { mediaUrl } from '../chat/widgets/media-url'
import { EvaModal } from '../overlay'
import { portraitOf } from './roster'

export function ProviderMark({ provider, size }: { provider: CouncilProvider; size: number }) {
  return provider === 'anthropic' ? (
    <IconAnthropic size={size} className="eva-dial-anthropic" aria-hidden />
  ) : (
    <IconBrandOpenai size={size} stroke={1.75} aria-hidden />
  )
}

/** A person's portrait with the maker of their model on a small badge. */
export function SeatAvatar({
  name,
  color,
  model,
  size = 32,
}: {
  name: string
  color: string
  model: CouncilModelKey
  size?: number
}) {
  return (
    <span className="eva-dial-av">
      <Avatar
        size={size}
        radius="xl"
        color={color}
        src={portraitOf(name)}
        alt=""
        className="eva-room-avatar"
      >
        {(Array.from(name)[0] ?? '?').toUpperCase()}
      </Avatar>
      <span className="eva-dial-av-badge" title={COUNCIL_MODELS[model].provider}>
        <ProviderMark provider={COUNCIL_MODELS[model].provider} size={9} />
      </span>
    </span>
  )
}

export function RolePill({ role }: { role: CouncilRole }) {
  return (
    <span className="eva-role-pill" data-role={role}>
      {COUNCIL_ROLE_LABEL[role]}
    </span>
  )
}

export function PartPill({ part, branch }: { part: string; branch?: 'A' | 'B' | undefined }) {
  return <span className="eva-part-pill">{branch ? `${part} ${branch}` : part}</span>
}

/** "Opus 5.5 · Claude Code", with the thinking level when given. */
export const modelLine = (
  model: CouncilModelKey,
  harness: CouncilHarness,
  thinking?: CouncilThinking,
): string =>
  [
    COUNCIL_MODELS[model].name,
    COUNCIL_HARNESS_LABEL[harness],
    ...(thinking ? [COUNCIL_THINKING_LABEL[thinking]] : []),
  ].join(' · ')

/** The first name of "Mara Voss". */
export const first = (name: string): string => name.split(' ')[0] ?? name

/** A render on this Mac, as the `src` of an img. */
export const renderSrc = (path: string): string => mediaUrl(path)

/** Thumbnails that open large on click. */
export function RenderStrip({
  renders,
  height = 112,
  label,
}: {
  renders: readonly RoomRender[]
  height?: number
  label?: string
}) {
  const [open, setOpen] = useState<RoomRender | null>(null)
  if (renders.length === 0) return null
  return (
    <>
      <div className="eva-renders" role="list" aria-label={label ?? 'Renders'}>
        {renders.map((r) => (
          <figure key={r.path} className="eva-render" role="listitem">
            <button
              type="button"
              className="eva-render-btn"
              aria-label={`Open ${r.caption || 'render'} large`}
              onClick={() => setOpen(r)}
            >
              <img src={renderSrc(r.path)} alt={r.caption} style={{ height }} loading="lazy" />
            </button>
            {r.caption ? <figcaption>{r.caption}</figcaption> : null}
          </figure>
        ))}
      </div>
      <RenderLightbox render={open} onClose={() => setOpen(null)} />
    </>
  )
}

export function RenderLightbox({
  render,
  onClose,
}: {
  render: RoomRender | null
  onClose: () => void
}) {
  return (
    <EvaModal
      opened={render !== null}
      onClose={onClose}
      title={render?.caption || 'Render'}
      size={960}
      testid="room-lightbox"
    >
      {render ? (
        <img className="eva-lightbox-img" src={renderSrc(render.path)} alt={render.caption} />
      ) : null}
    </EvaModal>
  )
}
