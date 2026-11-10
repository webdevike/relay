import {
  Group,
  Loader,
  Progress,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
} from '@mantine/core'
import {
  IconAlertTriangle,
  IconClockHour4,
  IconCoin,
  IconUser,
  type Icon,
} from '@tabler/icons-react'
import { useEffect, useState, type ReactNode } from 'react'
import {
  STATS_RANGES,
  type StatsRange,
  type StatsRangeKey,
  type StatsTotals,
} from '@evaos/contract'
import { SeriesChart } from '../stats/SeriesChart'
import { startStats, useStats } from '../stats/stats-store'
import { parseOneOf, usePref } from '../ui-prefs'
import {
  RANGE_LABEL,
  compact,
  count,
  duration,
  folderLabel,
  headAndTail,
  insights,
  money,
  moneyAxis,
  percent,
  rate,
  tokens,
  type InsightKind,
} from '../stats/stats-view'
import '../stats/stats.css'

const ACCENT = 'var(--eva-c-primary-background)'
const MUTED = 'color-mix(in srgb, var(--eva-c-muted-foreground) 45%, transparent)'
const DANGER = 'var(--eva-c-danger)'

const INSIGHT_ICON: Record<InsightKind, Icon> = {
  cost: IconCoin,
  agent: IconUser,
  failing: IconAlertTriangle,
  slow: IconClockHour4,
}

function ago(at: number, now: number): string {
  const min = Math.round((now - at) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min.toString()} min ago`
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(at)
}

function Block({
  title,
  children,
  testid,
}: {
  title: string
  children: ReactNode
  testid: string
}) {
  return (
    <Stack gap="sm" data-testid={testid}>
      <Text size="sm" fw={600}>
        {title}
      </Text>
      {children}
    </Stack>
  )
}

function Figure({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <Stack gap={0}>
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text size="xl" fw={600} className="eva-stats-num">
        {value}
      </Text>
      <Text size="xs" c="dimmed" className="eva-stats-num">
        {detail}
      </Text>
    </Stack>
  )
}

function Headline({ r, range }: { r: StatsRange; range: StatsRangeKey }) {
  const t = r.totals
  const prompt = t.inputTokens + t.cacheReadTokens
  return (
    <Stack gap="md" data-testid="stats-headline">
      <Stack gap={0}>
        <Text size="sm" c="dimmed">{`Spent ${RANGE_LABEL[range].phrase}`}</Text>
        <Text fz={40} fw={600} lh={1.1} className="eva-stats-num" data-testid="stats-spend">
          {money(t.costUsd)}
        </Text>
      </Stack>
      <SimpleGrid cols={3} spacing="lg">
        <Figure
          label="Requests"
          value={count(t.requests)}
          detail={
            t.failed === 0
              ? 'none failed'
              : `${count(t.failed)} failed (${percent(t.failed, t.requests)})`
          }
        />
        <Figure
          label="Tokens"
          value={compact(tokens(t))}
          detail={`${compact(t.outputTokens)} written by models`}
        />
        <Figure
          label="Saved by caching"
          value={money(t.cacheSavingsUsd)}
          detail={`${percent(t.cacheReadTokens, prompt)} of prompt tokens cached`}
        />
      </SimpleGrid>
    </Stack>
  )
}

function Insights({ r }: { r: StatsRange }) {
  const list = insights(r)
  if (list.length === 0) return null
  return (
    <Block title="Worth a look" testid="stats-insights">
      <Stack gap="sm">
        {list.map((i) => {
          const Glyph = INSIGHT_ICON[i.kind]
          return (
            <Group key={i.kind} gap="sm" wrap="nowrap" align="flex-start" data-insight={i.kind}>
              <Glyph
                size={18}
                aria-hidden
                color={i.kind === 'failing' ? DANGER : 'var(--eva-c-muted-foreground)'}
                className="eva-stats-icon"
              />
              <Stack gap={0}>
                <Text size="sm" fw={500}>
                  {i.title}
                </Text>
                <Text size="xs" c="dimmed">
                  {i.detail}
                </Text>
              </Stack>
            </Group>
          )
        })}
      </Stack>
    </Block>
  )
}

const errorRate = (t: Pick<StatsTotals, 'failed' | 'requests'>): ReactNode =>
  t.failed === 0 ? (
    <Text span size="sm" c="dimmed">
      0
    </Text>
  ) : (
    <Text span size="sm" c={t.failed / t.requests >= 0.01 ? DANGER : undefined}>
      {percent(t.failed, t.requests)}
    </Text>
  )

function Num({ children }: { children: ReactNode }) {
  return <Table.Td className="eva-stats-num eva-stats-right">{children}</Table.Td>
}

function Head({ cols }: { cols: string[] }) {
  return (
    <Table.Thead>
      <Table.Tr>
        {cols.map((c, i) => (
          <Table.Th key={c} className={i === 0 ? undefined : 'eva-stats-right'}>
            {c}
          </Table.Th>
        ))}
      </Table.Tr>
    </Table.Thead>
  )
}

function Models({ r }: { r: StatsRange }) {
  return (
    <Block title="Models" testid="stats-models">
      <Table verticalSpacing="xs" withRowBorders={false} className="eva-stats-table">
        <Head cols={['Model', 'Spend', 'Requests', 'Errors', 'First token', 'Tokens/s']} />
        <Table.Tbody>
          {r.byModel.map((m) => (
            <Table.Tr key={`${m.provider}/${m.model}`}>
              <Table.Td>
                <Text size="sm" truncate title={`${m.model} (${m.provider})`}>
                  {m.model}
                </Text>
              </Table.Td>
              <Num>{money(m.costUsd)}</Num>
              <Num>{count(m.requests)}</Num>
              <Num>{errorRate(m)}</Num>
              <Num>{duration(m.avgTtftMs)}</Num>
              <Num>{rate(m.tokensPerSecond)}</Num>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Block>
  )
}

/** Name, spend with its share of the range, requests and errors: agents and projects alike. */
function Shares({
  title,
  testid,
  first,
  rows,
  total,
}: {
  title: string
  testid: string
  first: string
  rows: { key: string; name: string; hint?: string; t: StatsTotals }[]
  total: StatsTotals
}) {
  const { head, tail } = headAndTail(
    rows.map((row) => ({ ...row.t, row })),
    total,
  )
  const line = (
    key: string,
    name: ReactNode,
    hint: string,
    t: Pick<StatsTotals, 'costUsd' | 'requests' | 'failed'>,
  ) => (
    <Table.Tr key={key}>
      <Table.Td>
        <Text size="sm" truncate title={hint}>
          {name}
        </Text>
      </Table.Td>
      <Num>{money(t.costUsd)}</Num>
      <Num>
        <Text span size="sm" c="dimmed">
          {percent(t.costUsd, total.costUsd)}
        </Text>
      </Num>
      <Num>{count(t.requests)}</Num>
      <Num>{errorRate(t)}</Num>
    </Table.Tr>
  )
  return (
    <Block title={title} testid={testid}>
      <Table verticalSpacing="xs" withRowBorders={false} className="eva-stats-table">
        <Head cols={[first, 'Spend', 'Share', 'Requests', 'Errors']} />
        <Table.Tbody>
          {head.map(({ row, ...t }) => line(row.key, row.name, row.hint ?? row.name, t))}
          {tail &&
            line(
              'tail',
              <Text span size="sm" c="dimmed">
                Everything else
              </Text>,
              'Every row under 1% of spend',
              tail,
            )}
        </Table.Tbody>
      </Table>
    </Block>
  )
}

function Split({ r }: { r: StatsRange }) {
  const main = r.byAgentType.find((t) => t.type === 'main')
  const sub = r.byAgentType.find((t) => t.type === 'subagent')
  const spend = r.totals.costUsd
  if (spend <= 0) return null
  const share = ((main?.costUsd ?? 0) / spend) * 100
  return (
    <Block title="Main sessions and subagents" testid="stats-split">
      <Progress.Root size="sm" aria-label="Spend by main sessions and subagents">
        <Progress.Section value={share} color={ACCENT} />
        <Progress.Section value={100 - share} color={MUTED} />
      </Progress.Root>
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm" className="eva-stats-num">
          {`Main sessions ${money(main?.costUsd ?? 0)}`}
          <Text span size="sm" c="dimmed">
            {` ${percent(main?.costUsd ?? 0, spend)}, ${count(main?.requests ?? 0)} requests`}
          </Text>
        </Text>
        <Text size="sm" className="eva-stats-num">
          {`Subagents ${money(sub?.costUsd ?? 0)}`}
          <Text span size="sm" c="dimmed">
            {` ${percent(sub?.costUsd ?? 0, spend)}, ${count(sub?.requests ?? 0)} requests`}
          </Text>
        </Text>
      </Group>
    </Block>
  )
}

function Waiting({ children, busy }: { children: string; busy: boolean }) {
  return (
    <Group gap="sm" data-testid="stats-empty">
      {busy && <Loader size="xs" />}
      <Text size="sm" c="dimmed">
        {children}
      </Text>
    </Group>
  )
}

const parseRange = parseOneOf<StatsRangeKey>(STATS_RANGES)

/** Settings > Usage: what omp cost on the Relay Host, leading with what to act on. */
export function UsageSection() {
  useEffect(() => startStats(), [])
  const view = useStats((v) => v)
  const [range, setRange] = usePref<StatsRangeKey>('usage.range', '7d', parseRange)
  if (view === null) return <Waiting busy>Loading usage</Waiting>
  const snap = view.stats
  if (snap === null) return <Waiting busy={false}>{view.unavailable ?? 'No usage yet.'}</Waiting>
  if (snap.ranges === null) {
    return (
      <Waiting busy={snap.refreshing}>
        {snap.refreshing
          ? 'The Relay Host is adding up usage. The first time takes a few seconds.'
          : 'The Relay Host has no usage numbers yet.'}
      </Waiting>
    )
  }
  const r = snap.ranges[range]
  const failing = snap.profiles.filter((p) => p.error !== null)
  return (
    <Stack gap="xl" data-testid="stats-page">
      <Group justify="space-between" wrap="nowrap">
        <SegmentedControl
          size="xs"
          value={range}
          onChange={(v) => setRange(v as StatsRangeKey)}
          data={STATS_RANGES.map((k) => ({ value: k, label: RANGE_LABEL[k].short }))}
          data-testid="stats-range"
        />
        <Group gap="xs" wrap="nowrap">
          {snap.refreshing && <Loader size={12} />}
          <Text size="xs" c="dimmed" data-testid="stats-updated">
            {snap.updatedAt === null ? 'Updating' : `Updated ${ago(snap.updatedAt, Date.now())}`}
          </Text>
        </Group>
      </Group>
      <Headline r={r} range={range} />
      <Insights r={r} />
      <Block title="Spend over time" testid="stats-spend-chart">
        <SeriesChart
          points={r.series}
          range={range}
          bars={[{ key: 'costUsd', label: 'Spend', color: ACCENT }]}
          format={money}
          axis={moneyAxis}
          height={150}
          label={`Spend ${RANGE_LABEL[range].phrase}`}
          testid="stats-chart-spend"
        />
      </Block>
      <Block title="Requests over time" testid="stats-requests-chart">
        <SeriesChart
          points={r.series}
          range={range}
          bars={[
            { key: 'ok', label: 'Answered', color: MUTED },
            { key: 'failed', label: 'Failed', color: DANGER },
          ]}
          format={compact}
          height={100}
          label={`Requests ${RANGE_LABEL[range].phrase}`}
          testid="stats-chart-requests"
        />
      </Block>
      {r.byModel.length > 0 && <Models r={r} />}
      {r.byAgent.length > 0 && (
        <Shares
          title="Agents"
          testid="stats-agents"
          first="Agent"
          total={r.totals}
          rows={r.byAgent.map((a) => ({ key: a.agent, name: a.label, t: a }))}
        />
      )}
      <Split r={r} />
      {r.byFolder.length > 0 && (
        <Shares
          title="Projects"
          testid="stats-projects"
          first="Project"
          total={r.totals}
          rows={r.byFolder.map((f) => ({
            key: f.folder,
            name: folderLabel(f.folder),
            hint: f.folder,
            t: f,
          }))}
        />
      )}
      <Text size="xs" c="dimmed" data-testid="stats-source">
        {`From omp stats on the Relay Host, profiles ${snap.profiles.map((p) => p.name).join(', ')}.`}
        {failing.map((p) => ` ${p.name}: ${p.error ?? ''}. Its numbers may be old.`).join('')}
        {r.totals.unpriced > 0
          ? ` ${count(r.totals.unpriced)} requests have no price in omp and count as $0.`
          : ''}
      </Text>
    </Stack>
  )
}
