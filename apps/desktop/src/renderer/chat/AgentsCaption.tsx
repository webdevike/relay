import './agents-caption.css'
import { useState, type MouseEvent } from 'react'
import { Tooltip } from '@mantine/core'
import { IconChevronRight, IconCircleCheck, IconRosette } from '@tabler/icons-react'
import { agentClock, agentLabel, agentsCaption, type AgentRun } from '@relay/protocol'
import { openLink } from '../navigation/open-link'
import { openTargetOf } from '../navigation/open-target'
import { Markdown } from './markdown/Markdown'
import { useSecond } from './WorkCard'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** `running` while any run is out, `failed` when none answered, else `done`. */
export function agentsState(runs: readonly AgentRun[]): AgentRun['status'] {
  if (runs.some((r) => r.status === 'running')) return 'running'
  return runs.some((r) => r.status === 'done') ? 'done' : 'failed'
}

/** A field's value as text, or null when it needs the JSON block. */
function plain(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(', ')
  return null
}

function Fields({ entries }: { entries: [string, unknown][] }) {
  return (
    <dl className="eva-agents-fields">
      {entries.map(([key, value]) => {
        const text = plain(value)
        return (
          <div key={key} className="eva-agents-field">
            {/* `maxSources` reads `Max sources`. */}
            <dt>{agentLabel(key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase())}</dt>
            <dd>
              {text !== null ? (
                text
              ) : (
                <pre className="eva-tool-code">{JSON.stringify(value, null, 2)}</pre>
              )}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

interface Citation {
  url: string
  quote?: string
  verified: boolean
}

function citationsOf(reply: Json | undefined): Citation[] {
  const list = reply?.['citations']
  if (!Array.isArray(list)) return []
  return list.filter(isObj).flatMap((c) =>
    typeof c['url'] === 'string'
      ? [
          {
            url: c['url'],
            ...(typeof c['quote'] === 'string' ? { quote: c['quote'] } : {}),
            verified: c['verified'] === true,
          },
        ]
      : [],
  )
}

/** `apple.com/newsroom/...`: a source link's short name. */
function sourceName(url: string): string {
  try {
    const u = new URL(url)
    const rest = `${u.pathname}${u.search}`.replace(/\/$/, '')
    return `${u.hostname.replace(/^www\./, '')}${rest}`
  } catch {
    return url
  }
}

function Sources({ citations }: { citations: Citation[] }) {
  return (
    <ol className="eva-agents-sources" data-testid="agents-sources">
      {citations.map((c, i) => (
        <li key={`${i}-${c.url}`} className="eva-agents-source">
          <div className="eva-agents-source-head">
            <a
              href={c.url}
              title={c.url}
              className="eva-agents-source-link"
              onClick={(e: MouseEvent) => {
                e.preventDefault()
                openLink(c.url, { target: openTargetOf(e) })
              }}
            >
              {sourceName(c.url)}
            </a>
            {c.verified ? (
              <Tooltip label="Quote found on the page" openDelay={300}>
                <span
                  className="eva-agents-verified"
                  data-testid="agents-verified"
                  aria-label="Verified"
                >
                  <IconCircleCheck size={14} stroke={1.75} aria-hidden />
                </span>
              </Tooltip>
            ) : null}
          </div>
          {c.quote ? <q className="eva-agents-quote">{c.quote}</q> : null}
        </li>
      ))}
    </ol>
  )
}

/** `$0.004`, `$0.12`: two decimals from a cent up, up to four below it. */
export function costLabel(cost: number): string {
  return `$${cost < 0.01 ? Number(cost.toFixed(4)) : cost.toFixed(2)}`
}

/** One run: what was asked, the typed reply (its answer, other fields and sources), the error. The caption's details and the Agents page's run panel show it. */
export function RunDetails({ run }: { run: AgentRun }) {
  const reply = isObj(run.reply) ? run.reply : undefined
  const answer = run.text ?? (typeof reply?.['answer'] === 'string' ? reply['answer'] : undefined)
  const citations = citationsOf(reply)
  const request = isObj(run.request) ? run.request : undefined
  // A reply that echoes a request field (web-researcher's `question`) says it once, under what was asked.
  const rest = reply
    ? Object.entries(reply).filter(
        ([k, v]) =>
          k !== 'answer' &&
          k !== 'text' &&
          k !== 'citations' &&
          !(request && k in request && JSON.stringify(request[k]) === JSON.stringify(v)),
      )
    : []
  const asked = request
    ? Object.entries(request)
    : run.request === undefined
      ? []
      : [['request', run.request] as [string, unknown]]
  const stats = [
    run.status === 'running' ? 'Working' : run.status === 'failed' ? 'Failed' : null,
    run.seconds !== undefined ? agentClock(run.seconds * 1000, false) : null,
    run.cost === undefined ? null : costLabel(run.cost),
  ].filter((s): s is string => s !== null)
  return (
    <section className="eva-agents-run" data-testid="agents-run" data-state={run.status}>
      <div className="eva-agents-run-head">
        <span className="eva-agents-run-name">{agentLabel(run.agent)}</span>
        {stats.length > 0 ? <span>{stats.join(' · ')}</span> : null}
      </div>
      {asked.length > 0 ? <Fields entries={asked} /> : null}
      {run.error ? (
        <div className="eva-agents-error" data-testid="agents-error">
          {run.error}
        </div>
      ) : null}
      {answer ? (
        <div className="eva-agents-answer" data-testid="agents-answer">
          <Markdown text={answer} />
        </div>
      ) : null}
      {rest.length > 0 ? <Fields entries={rest} /> : null}
      {citations.length > 0 ? <Sources citations={citations} /> : null}
    </section>
  )
}

/**
 * The specialist agents a turn used, on its reply (or, before the reply, on the turn's last
 * agents call): a rosette in the left margin and one muted caption line under the reply, its clock
 * ticking while a run is out. A click on the caption shows each run's request and typed reply.
 */
export function AgentsCaption({ runs }: { runs: readonly AgentRun[] }) {
  const state = agentsState(runs)
  const now = useSecond(state === 'running')
  const [open, setOpen] = useState(false)
  const names = [...new Set(runs.map((r) => agentLabel(r.agent)))].join(', ')
  return (
    <div className="eva-agents" data-testid="agents-caption" data-state={state}>
      <Tooltip label={`Specialist: ${names}`} openDelay={300}>
        <span className="eva-agents-badge" data-testid="agents-badge">
          <IconRosette size={16} stroke={1.5} aria-hidden />
        </span>
      </Tooltip>
      <button
        type="button"
        className="eva-agents-line"
        data-testid="agents-caption-line"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="eva-agents-text">{agentsCaption(runs, now)}</span>
        <IconChevronRight
          size={12}
          stroke={1.75}
          className="eva-chevron"
          data-open={open}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="eva-agents-details" data-testid="agents-details">
          {runs.map((r, i) => (
            <RunDetails key={r.run ?? `${r.agent}-${i}`} run={r} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
