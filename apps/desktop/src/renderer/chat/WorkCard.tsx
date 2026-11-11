import { useContext, useEffect, useState } from 'react'
import { ActionIcon, Tooltip } from '@mantine/core'
import { IconAlertTriangle, IconMessagePlus } from '@tabler/icons-react'
import { pageFromKey, placeOf } from '@evaos/shell-core'
import { workLink, type GuestEntry } from '@evaos/chat-core/guest-entry'
import { AgentPortrait } from '../assistants/AgentPortrait'
import { openFromNav } from '../navigation/open-in-app'
import { ReactionScope } from './reactions/reactions-store'
import { useGuestStyle } from './guest-style'

/** `0:02`, `14:05`, `1:02:09`: how long the work has run so far. */
function clock(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000)
  const mm = String(Math.floor(s / 60) % 60)
  const ss = String(s % 60).padStart(2, '0')
  return s < 3600 ? `${mm}:${ss}` : `${Math.floor(s / 3600)}:${mm.padStart(2, '0')}:${ss}`
}

/** `14s`, `2m 14s`, `1h 5m`: how long finished work took. */
function took(ms: number): string {
  const s = Math.round(Math.max(0, ms) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`
}

/** `14s`, `2m`, `1h`: the time when the card is narrow. */
function short(ms: number): string {
  const s = Math.round(Math.max(0, ms) / 1000)
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`
}

/** Now, every second while `on`. */
function useSecond(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [on])
  return now
}

/**
 * Work another assistant took on from this chat, as one row (variant A): its face, the title
 * while it works and the result line once done, the time on the right (it runs while working). A
 * border orbits the card while the work runs. The whole row opens where the work happens (the
 * assistant's chat); a follow-up button on hover puts `@Name ` in this chat's composer. Narrow,
 * the result keeps the room: the time shortens, then goes.
 */
export function WorkCard({ entry }: { entry: GuestEntry }) {
  const work = entry.work!
  const style = useGuestStyle(entry.agent)
  const reply = useContext(ReactionScope)?.reply
  const working = work.state === 'working'
  const now = useSecond(working)
  const line = working ? work.title : (entry.text ?? work.title)
  const ran = (work.endedAt ?? now) - work.startedAt
  const page = pageFromKey(workLink(entry)) ?? `agent:${entry.agent.id}`
  const name = entry.agent.title
  return (
    <div
      className="eva-work"
      data-testid="work-card"
      data-state={work.state}
      role="link"
      tabIndex={0}
      style={style}
      title={`Open ${name}'s chat: ${line}`}
      onClick={(e) => openFromNav(placeOf(page), e)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openFromNav(placeOf(page), e)
        }
      }}
    >
      <AgentPortrait id={entry.agent.id} className="eva-work-face" />
      <span className="eva-work-line" data-testid="work-card-line">
        {work.state === 'failed' ? (entry.text ?? `Stopped ${work.title}`) : line}
      </span>
      {work.state === 'done' && reply !== undefined ? (
        <Tooltip label={`Ask ${name} a follow-up`} openDelay={300}>
          <ActionIcon
            className="eva-work-ask"
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={`Ask ${name} a follow-up`}
            data-testid="work-card-ask"
            onClick={(e) => {
              e.stopPropagation()
              reply(`@${name} `)
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <IconMessagePlus size={16} stroke={1.75} />
          </ActionIcon>
        </Tooltip>
      ) : null}
      {work.state === 'failed' ? (
        <span className="eva-work-meta" data-bad>
          <IconAlertTriangle size={14} stroke={1.75} aria-hidden />
          <span>Stopped</span>
        </span>
      ) : (
        <span className="eva-work-meta" data-testid="work-card-time">
          <span className="eva-work-time-full">{working ? clock(ran) : took(ran)}</span>
          <span className="eva-work-time-short">{short(ran)}</span>
        </span>
      )}
    </div>
  )
}
