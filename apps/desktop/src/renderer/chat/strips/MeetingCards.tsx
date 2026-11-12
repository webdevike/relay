import './meeting-cards.css'
import { useMemo } from 'react'
import { MEETING_STAGE_LABEL, meetingCardsFor, meetingClock } from '@relay/protocol'
import { placeOf } from '@evaos/shell-core'
import type { Recording } from '@evaos/contract'
import { AgentFace } from '../../browser/AgentCaption'
import { agentOf, useAssistants } from '../../assistants/assistants-store'
import { clockLabel } from '../../context/format'
import {
  recordingTitle,
  useMeetings,
  useMeetingsSurface,
  useTicker,
} from '../../meetings/meetings-store'
import { navigateTo } from '../../tabs/tabs-store'
import { openMeetingTab } from '../../tiling/tiling-store'
import { useDismissedIds } from '../status-card/dismissed-cards'
import { StatusCard } from '../status-card/StatusCard'

/** A meeting card's id: the live card and the ended one are different cards. */
export const meetingCardId = (r: Pick<Recording, 'id'>, live: boolean): string =>
  live ? `meeting:${r.id}` : `meeting-ended:${r.id}`

/** "Meeting ended · 42 min · Developer Sync". */
export function endedLine(r: Pick<Recording, 'title' | 'app' | 'startedAt' | 'endedAt'>): string {
  const min = Math.max(1, Math.round(((r.endedAt ?? r.startedAt) - r.startedAt) / 60_000))
  return `Meeting ended · ${min} min · ${recordingTitle(r)}`
}

/** The ended card's quiet end: what the host is doing with it, else when it ended. */
export function endedMeta(r: Pick<Recording, 'stage' | 'startedAt' | 'endedAt'>, now: number) {
  return r.stage === 'done' || r.stage === 'failed'
    ? clockLabel(r.endedAt ?? r.startedAt, now)
    : MEETING_STAGE_LABEL[r.stage]
}

/**
 * The meetings routed to assistant `agent`, one row each above its composer: "Meeting in progress"
 * with the elapsed time while the call runs (a click opens it beside the chat), then "Meeting
 * ended" with Summary once the notes are written, until Isaac dismisses it or 12 hours pass.
 */
export function MeetingCards({ agent }: { agent: string }) {
  useMeetingsSurface()
  const recordings = useMeetings((s) => s.recordings)
  const name = useAssistants((s) => agentOf(s, agent)?.title ?? agent)
  const anyLive = recordings.some((r) => r.assistant === agent && r.stage === 'recording')
  const now = useTicker(anyLive)
  const dismissed = useDismissedIds()
  const cards = useMemo(
    () =>
      meetingCardsFor(recordings, agent, now).filter(
        (c) => !dismissed.includes(meetingCardId(c.recording, c.live)),
      ),
    [recordings, agent, now, dismissed],
  )
  if (cards.length === 0) return null
  const face = <AgentFace agent={{ id: agent, name }} size="s" />
  return (
    <div className="eva-meeting-cards" data-testid="meeting-cards">
      {cards.map(({ recording: r, live }) => {
        const title = recordingTitle(r)
        if (live) {
          const line = `Meeting in progress · ${title}`
          return (
            <StatusCard
              key={r.id}
              id={meetingCardId(r, true)}
              testId="meeting-card"
              label="Open the meeting"
              lead={face}
              line={
                <>
                  <span className="eva-meeting-dot" role="img" aria-label="Live" />
                  Meeting in progress <span className="eva-meeting-title">· {title}</span>
                </>
              }
              lineTitle={line}
              meta={<span data-testid="meeting-elapsed">{meetingClock(now - r.startedAt)}</span>}
              dismissible={false}
              onOpen={() => openMeetingTab(r.id)}
            />
          )
        }
        const line = endedLine(r)
        return (
          <StatusCard
            key={r.id}
            id={meetingCardId(r, false)}
            testId="meeting-ended"
            label="Open the meeting"
            lead={face}
            line={line}
            lineTitle={line}
            data={{ 'data-stage': r.stage }}
            onOpen={() => openMeetingTab(r.id)}
            actions={
              r.stage === 'done' ? (
                <button
                  type="button"
                  className="eva-agent-btn eva-agent-btn-quiet"
                  data-testid="meeting-summary"
                  onClick={() => navigateTo(placeOf('meetings', { meeting: r.id }))}
                >
                  Summary
                </button>
              ) : undefined
            }
            meta={endedMeta(r, now)}
          />
        )
      })}
    </div>
  )
}
