import { Button } from '@mantine/core'
import { IconAlertTriangle, IconCheck, IconPin, IconX } from '@tabler/icons-react'
import { useState } from 'react'
import { COUNCIL_TARGET_SCORE, councilMoney, councilOwnerPart } from '@relay/protocol'
import type { RoomCard } from '@evaos/contract'
import { Markdown } from '../chat/markdown/Markdown'
import { PartPill, RenderStrip, modelLine, renderSrc, RenderLightbox, first } from './council-bits'
import { answerAsk, budgetRoom } from './rooms-store'
import type { RoomAgent } from './types'

type CardOf<T extends RoomCard['type']> = Extract<RoomCard, { type: T }>

interface CardCtx {
  roomId: string
  agents: readonly RoomAgent[]
  /** The room's parts, to name the part a rubric owner lands on. */
  parts: readonly string[]
}

const nameOf = (agents: readonly RoomAgent[], id: string): string => {
  const a = agents.find((x) => x.id === id)
  return a ? first(a.name) : id
}

const seatLineOf = (agents: readonly RoomAgent[], id: string): string => {
  const s = agents.find((x) => x.id === id)?.seat
  return s ? modelLine(s.modelKey, s.harness) : ''
}

const score = (v: number): string => v.toFixed(1)
const signed = (v: number): string => `${v > 0 ? '+' : v < 0 ? '-' : ''}${Math.abs(v).toFixed(1)}`

const VERDICT: Record<CardOf<'scorecard'>['verdict'], string> = {
  continue: 'Next round',
  converged: 'Converged',
  plateau: 'Plateau',
  cap: 'Round cap',
  branch: 'Branches picked',
  stopped: 'Stopped',
}

function ContractCard({ card }: { card: CardOf<'contract'> }) {
  const [all, setAll] = useState(false)
  return (
    <div className="eva-card" data-testid="card-contract">
      <div className="eva-card-head">
        <b>Contract v{card.version}</b>
        <span className="eva-card-path" title={card.path}>
          {card.path}
        </span>
      </div>
      <div className="eva-contract" data-open={all || undefined}>
        <Markdown text={card.text} />
      </div>
      <Button variant="subtle" color="gray" size="compact-sm" onClick={() => setAll((o) => !o)}>
        {all ? 'Show less' : 'Show all'}
      </Button>
    </div>
  )
}

const STATUS: Record<CardOf<'parts'>['parts'][number]['status'], string> = {
  ok: 'Merged',
  failed: 'Failed',
  bounced: 'Sent back',
}

function PartsCard({ card, ctx }: { card: CardOf<'parts'>; ctx: CardCtx }) {
  const [open, setOpen] = useState<{ path: string; caption: string } | null>(null)
  return (
    <div className="eva-card" data-testid="card-parts">
      <div className="eva-card-head">
        <b>Round {card.round} parts</b>
      </div>
      <div className="eva-board">
        {card.parts.map((p) => (
          <figure key={`${p.part}-${p.agentId}-${p.branch ?? ''}`} className="eva-board-part">
            {p.render ? (
              <button
                type="button"
                className="eva-render-btn"
                aria-label={`Open ${p.part} large`}
                onClick={() => setOpen({ path: p.render!, caption: p.part })}
              >
                <img src={renderSrc(p.render)} alt={p.part} loading="lazy" />
              </button>
            ) : (
              <span className="eva-board-empty">No render</span>
            )}
            <figcaption>
              <span className="eva-board-line">
                <b>{p.part}</b>
                <span className="eva-status" data-status={p.status}>
                  {STATUS[p.status]}
                </span>
              </span>
              <span className="eva-dim">
                {nameOf(ctx.agents, p.agentId)}
                {p.branch ? ` (${p.branch})` : ''}
                {seatLineOf(ctx.agents, p.agentId) ? ` · ${seatLineOf(ctx.agents, p.agentId)}` : ''}
              </span>
              <span>{p.note}</span>
            </figcaption>
          </figure>
        ))}
      </div>
      <RenderLightbox render={open} onClose={() => setOpen(null)} />
    </div>
  )
}

function ScorecardCard({ card, ctx }: { card: CardOf<'scorecard'>; ctx: CardCtx }) {
  return (
    <div className="eva-card" data-testid="card-scorecard">
      <div className="eva-card-head">
        <b>Round {card.round} scorecard</b>
        <span className="eva-verdict" data-verdict={card.verdict}>
          {VERDICT[card.verdict]}
        </span>
      </div>
      <div className="eva-score" role="table" aria-label={`Round ${card.round} scores`}>
        {card.criteria.map((c) => (
          <div key={c.id} className="eva-score-row" role="row">
            <span className="eva-score-name" role="cell">
              {c.name}
              <PartPill part={councilOwnerPart(c.owner, ctx.parts)} />
            </span>
            <span className="eva-score-bar" role="cell" aria-hidden>
              <b
                style={{ width: `${Math.max(0, Math.min(10, c.score)) * 10}%` }}
                data-met={c.score >= COUNCIL_TARGET_SCORE || undefined}
              />
            </span>
            <span className="eva-score-val" role="cell">
              {score(c.score)}
              {c.delta !== undefined && c.delta !== 0 ? (
                <small data-dir={c.delta > 0 ? 'up' : 'down'}>{signed(c.delta)}</small>
              ) : null}
            </span>
          </div>
        ))}
      </div>
      <div className="eva-score-total">
        <span>Total</span>
        <b>{score(card.total)} of 10</b>
      </div>
      {card.note ? <p className="eva-card-note">{card.note}</p> : null}
      {card.fixes.length > 0 ? (
        <ul className="eva-fixes">
          {card.fixes.map((f, i) => (
            <li key={i}>
              <PartPill part={f.part} /> {f.text}
            </li>
          ))}
        </ul>
      ) : null}
      {card.log.length > 0 ? (
        <details className="eva-council-log">
          <summary>Routing log, {card.log.length} turns</summary>
          <table>
            <thead>
              <tr>
                <th>Seat</th>
                <th>Kind</th>
                <th>Model · harness</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {card.log.map((e, i) => (
                <tr key={`${e.seat}-${i}`}>
                  <td>
                    {nameOf(ctx.agents, e.seat)}
                    {e.part ? <span className="eva-dim"> · {e.part}</span> : null}
                  </td>
                  <td>{e.kind}</td>
                  <td className="eva-dim">{modelLine(e.model, e.harness)}</td>
                  <td className="eva-num">{councilMoney(e.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </div>
  )
}

/** Two buttons that answer once; main's next room carries `answered`, so they stay until then. */
function useAnswer<T>(send: (value: T) => Promise<string | null>): {
  busy: boolean
  error: string | null
  go: (value: T) => void
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return {
    busy,
    error,
    go: (value) => {
      setBusy(true)
      setError(null)
      void send(value).then((err) => {
        setBusy(false)
        if (err) setError(err)
      })
    },
  }
}

function PauseCard({ card, ctx }: { card: CardOf<'pause'>; ctx: CardCtx }) {
  const a = useAnswer((choice: 'continue' | 'wrap') => budgetRoom(ctx.roomId, choice))
  return (
    <div className="eva-card" data-tone="warn" data-testid="card-pause">
      <div className="eva-card-head">
        <b className="eva-card-title-icon">
          <IconAlertTriangle size={14} stroke={1.75} aria-hidden />
          Over budget soon
        </b>
      </div>
      <p className="eva-card-note">
        Spent {councilMoney(card.spent)} of the {councilMoney(card.cap)} cap. The room is paused
        until you choose.
      </p>
      {card.answered ? (
        <p className="eva-answered" data-testid="pause-answered">
          <IconCheck size={14} stroke={1.75} aria-hidden />
          {card.answered === 'continue'
            ? `Continuing, cap raised to ${councilMoney(card.nextCap)}`
            : 'Wrapping up now'}
        </p>
      ) : (
        <div className="eva-card-actions">
          <Button
            size="sm"
            loading={a.busy}
            onClick={() => a.go('continue')}
            data-testid="pause-continue"
          >
            Continue to {councilMoney(card.nextCap)}
          </Button>
          <Button
            size="sm"
            variant="default"
            disabled={a.busy}
            onClick={() => a.go('wrap')}
            data-testid="pause-wrap"
          >
            Wrap now
          </Button>
          {a.error ? <span className="eva-card-error">{a.error}</span> : null}
        </div>
      )}
    </div>
  )
}

function AskCard({ card, ctx }: { card: CardOf<'ask'>; ctx: CardCtx }) {
  const a = useAnswer((allow: boolean) => answerAsk(ctx.roomId, card.askId, allow))
  return (
    <div className="eva-card" data-tone="warn" data-testid={`card-ask-${card.askId}`}>
      <div className="eva-card-head">
        <b>{nameOf(ctx.agents, card.agentId)} wants to act outside the room</b>
      </div>
      <code className="eva-ask-action">{card.action}</code>
      {card.answered ? (
        <p className="eva-answered" data-testid="ask-answered">
          {card.answered === 'allow' ? (
            <IconCheck size={14} stroke={1.75} aria-hidden />
          ) : (
            <IconX size={14} stroke={1.75} aria-hidden />
          )}
          {card.answered === 'allow' ? 'Allowed' : 'Denied'}
        </p>
      ) : (
        <div className="eva-card-actions">
          <Button size="sm" loading={a.busy} onClick={() => a.go(true)} data-testid="ask-allow">
            Allow
          </Button>
          <Button
            size="sm"
            variant="default"
            disabled={a.busy}
            onClick={() => a.go(false)}
            data-testid="ask-deny"
          >
            Deny
          </Button>
          {a.error ? <span className="eva-card-error">{a.error}</span> : null}
        </div>
      )}
    </div>
  )
}

function DeliverableCard({ card, ctx }: { card: CardOf<'deliverable'>; ctx: CardCtx }) {
  return (
    <div className="eva-card eva-deliverable" data-testid="card-deliverable">
      <div className="eva-card-head">
        <b className="eva-card-title-icon">
          <IconPin size={14} stroke={1.5} aria-hidden />
          Deliverable
        </b>
      </div>
      <div className="eva-stats">
        <div>
          <b>{card.total === undefined ? 'Not scored' : score(card.total)}</b>
          <span>{card.total === undefined ? 'no scorecard ran' : 'of 10'}</span>
        </div>
        <div>
          <b>{councilMoney(card.spent)}</b>
          <span>list spend</span>
        </div>
        <div>
          <b>{card.minutes} min</b>
          <span>elapsed</span>
        </div>
      </div>
      <div className="eva-before-after">
        <div>
          <span className="eva-dim">Before</span>
          <RenderStrip renders={card.before} height={120} label="Before renders" />
        </div>
        <div>
          <span className="eva-dim">After</span>
          <RenderStrip renders={card.after} height={120} label="After renders" />
        </div>
      </div>
      {card.changes.length > 0 ? (
        <div className="eva-card-sec">
          <b>What changed</b>
          <ul>
            {card.changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {card.dissent.length > 0 ? (
        <div className="eva-card-sec">
          <b>Dissent</b>
          <ul>
            {card.dissent.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {card.who.length > 0 ? (
        <div className="eva-card-sec">
          <b>Who did what</b>
          <table className="eva-who" data-testid="deliverable-who">
            <thead>
              <tr>
                <th>Seat</th>
                <th>Did</th>
                <th>Turns</th>
                <th>Cost</th>
                <th>Moved</th>
              </tr>
            </thead>
            <tbody>
              {card.who.map((w) => (
                <tr key={`${w.agentId}-${w.part ?? ''}`}>
                  <td data-label="Seat">
                    <span className="eva-who-name">
                      {nameOf(ctx.agents, w.agentId)}
                      {w.part ? <PartPill part={w.part} /> : null}
                    </span>
                    <span className="eva-dim">{seatLineOf(ctx.agents, w.agentId)}</span>
                  </td>
                  <td data-label="Did">{w.did}</td>
                  <td data-label="Turns" className="eva-num">
                    {w.turns}
                  </td>
                  <td data-label="Cost" className="eva-num">
                    {councilMoney(w.usd)}
                  </td>
                  <td data-label="Moved">{w.moved}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <dl className="eva-paths">
        <dt>Workdir</dt>
        <dd title={card.workdir} data-testid="deliverable-workdir">
          {card.workdir}
        </dd>
        {card.record ? (
          <>
            <dt>Record</dt>
            <dd title={card.record}>{card.record}</dd>
          </>
        ) : null}
        {card.routingFile ? (
          <>
            <dt>Routing log</dt>
            <dd title={card.routingFile}>{card.routingFile}</dd>
          </>
        ) : null}
      </dl>
      <p className="eva-dim">Nothing was copied back to the source. Merge the workdir by hand.</p>
    </div>
  )
}

export function CouncilCard({ card, ctx }: { card: RoomCard; ctx: CardCtx }) {
  switch (card.type) {
    case 'contract':
      return <ContractCard card={card} />
    case 'parts':
      return <PartsCard card={card} ctx={ctx} />
    case 'scorecard':
      return <ScorecardCard card={card} ctx={ctx} />
    case 'pause':
      return <PauseCard card={card} ctx={ctx} />
    case 'ask':
      return <AskCard card={card} ctx={ctx} />
    case 'deliverable':
      return <DeliverableCard card={card} ctx={ctx} />
  }
}
