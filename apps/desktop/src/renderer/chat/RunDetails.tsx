import './run-details.css'
import type { MouseEvent } from 'react'
import { Tooltip } from '@mantine/core'
import { IconCircleCheck } from '@tabler/icons-react'
import { agentClock, agentLabel, agentModelLine, type AgentRun } from '@relay/protocol'
import { openLink } from '../navigation/open-link'
import { openTargetOf } from '../navigation/open-target'
import { Markdown } from './markdown/Markdown'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A field's value as text, or null when it needs the JSON block. */
function plain(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(', ')
  return null
}

function Fields({
  entries,
  testIds,
}: {
  entries: [string, unknown][]
  testIds?: Readonly<Record<string, string>>
}) {
  return (
    <dl className="eva-agents-fields">
      {entries.map(([key, value]) => {
        const text = plain(value)
        return (
          <div key={key} className="eva-agents-field">
            {/* `maxSources` reads `Max sources`. */}
            <dt>{agentLabel(key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase())}</dt>
            <dd data-testid={testIds?.[key]}>
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
  const modelLine = agentModelLine(run)
  return (
    <section className="eva-agents-run" data-testid="agents-run" data-state={run.status}>
      <div className="eva-agents-run-head">
        <span className="eva-agents-run-name">{agentLabel(run.agent)}</span>
        {stats.length > 0 ? <span>{stats.join(' · ')}</span> : null}
      </div>
      {modelLine !== null || asked.length > 0 ? (
        <Fields
          entries={[
            ...(modelLine === null ? [] : [['model', modelLine] as [string, unknown]]),
            ...asked,
          ]}
          testIds={{ model: 'agents-model' }}
        />
      ) : null}
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
