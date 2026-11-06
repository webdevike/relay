import { Text } from '@mantine/core'
import type { SkillAssistant, SkillDetail, SkillRow } from '@evaos/contract'
import { AgentPortrait } from '../assistants/AgentPortrait'
import { agentLabel, lastUsedLabel } from './skills-model'

interface SkillUsageProps {
  row: SkillRow
  /** Null while it loads. */
  detail: SkillDetail | null
  assistants: readonly SkillAssistant[]
  now: number
}

const DAY = 86_400_000

/** The last 30 days as small bars, today last and in the accent; each bar says its day and count. */
function Trend({ daily, now }: { daily: readonly number[]; now: number }) {
  const max = Math.max(1, ...daily)
  return (
    <div className="eva-skills-trend-wrap">
      <div
        className="eva-skills-trend"
        role="img"
        aria-label={`${daily.reduce((a, b) => a + b, 0)} uses in the last 30 days`}
        data-testid="skill-trend"
      >
        {daily.map((count, i) => {
          const day = new Date(now - (daily.length - 1 - i) * DAY)
          const label = `${day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: ${count}`
          return (
            <span
              key={i}
              className="eva-skills-trend-bar"
              data-today={i === daily.length - 1 || undefined}
              data-empty={count === 0 || undefined}
              style={{ height: `${Math.max(4, (count / max) * 100)}%` }}
              title={label}
            />
          )
        })}
      </div>
      <div className="eva-skills-trend-axis eva-skills-dim">
        <span>30 days ago</span>
        <span>Today</span>
      </div>
    </div>
  )
}

/**
 * The Usage tab: how often the skill is loaded, the last 30 days, and by whom. A load is an agent
 * reading the skill (or Isaac's `/skill:`), counted by the Relay host from every session on this Mac.
 */
export function SkillUsage({ row, detail, assistants, now }: SkillUsageProps) {
  if (detail === null) {
    return (
      <Text size="sm" c="dimmed" p="md">
        Reading usage
      </Text>
    )
  }
  const stats = detail.stats
  if (stats === undefined) {
    return (
      <Text size="sm" c="dimmed" p="md" data-testid="skill-usage-old-host">
        Usage needs a newer Relay host on this Mac.
      </Text>
    )
  }
  if (stats === null) {
    return (
      <Text size="sm" c="dimmed" p="md">
        Counting uses across sessions
      </Text>
    )
  }
  if (stats.uses === 0) {
    return (
      <Text size="sm" c="dimmed" p="md" data-testid="skill-usage-never">
        No agent has loaded {row.name} yet.
      </Text>
    )
  }
  const figures: Array<[string, number]> = [
    ['All time', stats.uses],
    ['30 days', stats.uses30d],
    ['7 days', stats.uses7d],
  ]
  return (
    <div className="eva-skills-settings" data-testid="skill-usage">
      <div className="eva-skills-figures">
        {figures.map(([label, n]) => (
          <div key={label} className="eva-skills-figure">
            <span className="eva-skills-figure-n">{n.toLocaleString('en-US')}</span>
            <span className="eva-skills-dim">{label}</span>
          </div>
        ))}
      </div>
      {stats.lastUsedAt !== null ? (
        <Text size="sm" c="dimmed">
          Last used {lastUsedLabel(stats.lastUsedAt, now)}
          {stats.firstUsedAt !== null
            ? `, first ${new Date(stats.firstUsedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
            : ''}
        </Text>
      ) : null}

      <section className="eva-skills-section">
        <h3 className="eva-skills-label">Last 30 days</h3>
        <Trend daily={stats.daily} now={now} />
      </section>

      <section className="eva-skills-section">
        <h3 className="eva-skills-label">By agent</h3>
        <ul className="eva-skills-agents" data-testid="skill-by-agent">
          {stats.byAgent.map((use) => {
            const who = agentLabel(use, assistants)
            const assistant = use.kind === 'assistant' ? use.agent : use.owner
            return (
              <li key={`${use.kind}:${use.agent}:${use.owner ?? ''}`}>
                {assistant !== null && assistants.some((a) => a.id === assistant) ? (
                  <AgentPortrait id={assistant} className="eva-skills-portrait" />
                ) : (
                  <span className="eva-skills-portrait-gap" aria-hidden />
                )}
                <span className="eva-skills-agent">
                  <span className="eva-skills-agent-name">{who.name}</span>
                  <span className="eva-skills-dim">{who.detail}</span>
                </span>
                <span
                  className="eva-skills-num"
                  title={`Last used ${lastUsedLabel(use.lastUsedAt, now)}`}
                >
                  {use.uses.toLocaleString('en-US')}
                </span>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
