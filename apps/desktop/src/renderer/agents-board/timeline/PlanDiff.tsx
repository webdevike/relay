import { Badge, Button, Group, Loader, Table, Text, Tooltip, UnstyledButton } from '@mantine/core'
import { IconArrowDown, IconArrowUp, IconSparkles } from '@tabler/icons-react'
import { EvaModal } from '../../overlay'
import { NEEDS_NEWER_HOST, type PlanHandle } from './plan-actor'
import { addDays, changesOf, type DraftRow } from './plan-rules'
import type { PlanContext, PlanEvent, ReplanScope } from './plan.machine'
import type { ChartArea } from './DateLines'
import type { GhostBar } from './timeline-model'

/**
 * The plan draft over the Timeline (PLAN T7.3): ghost bars at the draft's dates (our own overlay;
 * SVAR's `baselines` are PRO-only), order arrows, each row's reason and error, Apply (a confirm
 * listing every change) and Discard, and "Ask Astra to re-plan".
 */

/** Ghost bars where the draft puts each ticket. */
export function PlanGhosts({ ghosts, area }: { ghosts: readonly GhostBar[]; area: ChartArea }) {
  return ghosts.map((g) => {
    const top = area.rowTop(g.key)
    if (top === null) return null
    const left = area.xOf(g.bar.start)
    const width = Math.max(area.xOf(addDays(g.bar.end, 1)) - left, 4)
    return (
      <div
        key={g.key}
        className="rb-ghost"
        data-ghost={g.key}
        data-error={g.error ? true : undefined}
        style={{ left, width, top, height: area.rowHeight }}
      />
    )
  })
}

/** Places a draft moves a row (positive: up). */
export function OrderBadge({ delta }: { delta: number }) {
  const Icon = delta > 0 ? IconArrowUp : IconArrowDown
  return (
    <Badge
      size="xs"
      variant="light"
      color="violet"
      leftSection={<Icon size={10} />}
      data-testid="plan-order"
    >
      {Math.abs(delta)}
    </Badge>
  )
}

export function ReplanButton({ plan, scope }: { plan: PlanHandle; scope: ReplanScope | null }) {
  const probe = scope ?? { projectId: '', label: '' }
  const busy = !plan.snap.can({ type: 'plan.replan', scope: probe })
  const why = !plan.canReplan ? NEEDS_NEWER_HOST : !scope ? 'Pick a row in a project first' : null
  const button = (
    <Button
      size="xs"
      variant="light"
      leftSection={<IconSparkles size={14} />}
      disabled={why !== null || busy}
      onClick={() => scope && plan.send({ type: 'plan.replan', scope })}
    >
      Ask Astra to re-plan
    </Button>
  )
  if (why === null) return button
  return (
    <Tooltip label={why} openDelay={200}>
      <span>{button}</span>
    </Tooltip>
  )
}

interface Head {
  title: string
  busy?: boolean
}

/** The strip's title per state (`changes`: "3 changes"); viewing has none. */
const HEADS: Partial<Record<string, (c: PlanContext, changes: string) => Head>> = {
  drafting: (_, changes) => ({ title: `Draft: ${changes}` }),
  replanning: (c) => ({ title: `Astra is re-planning ${c.scope?.label ?? ''}`, busy: true }),
  reviewingProposal: (c, changes) => ({ title: `Astra's plan: ${c.summary ?? changes}` }),
  confirming: (_, changes) => ({ title: `Draft: ${changes}` }),
  applying: (_, changes) => ({ title: `Applying ${changes}`, busy: true }),
  applied: () => ({ title: 'Plan applied' }),
  partiallyFailed: (_, changes) => ({ title: `${changes} not applied` }),
  unknown: (_, changes) => ({ title: `${changes}: not known yet whether Linear has them` }),
  checking: () => ({ title: 'Asking the host how the write ended', busy: true }),
  stale: () => ({ title: 'Changed since this draft: compare again before applying' }),
}

function headOf(plan: PlanHandle): Head | null {
  const { context, value } = plan.snap
  const n = context.rows.length
  return HEADS[String(value)]?.(context, `${n} ${n === 1 ? 'change' : 'changes'}`) ?? null
}

function rowLine(r: DraftRow): string {
  return changesOf([r])
    .map((c) => `${c.field} ${c.from} → ${c.to}`)
    .join(', ')
}

function PlanRows({
  rows,
  deltas,
  onOpen,
}: {
  rows: readonly DraftRow[]
  deltas: ReadonlyMap<string, number>
  onOpen(key: string): void
}) {
  return (
    <ul className="rb-plan-rows">
      {rows.map((r) => (
        <li key={r.key} data-plan-row={r.key} data-error={r.error ? true : undefined}>
          <Group gap="xs" wrap="nowrap">
            <UnstyledButton className="rb-plan-key" onClick={() => onOpen(r.key)}>
              {r.key}
            </UnstyledButton>
            {deltas.get(r.key) ? <OrderBadge delta={deltas.get(r.key)!} /> : null}
            <Text size="xs" c="dimmed" truncate>
              {rowLine(r)}
            </Text>
          </Group>
          {r.reason ? (
            <Text size="xs" className="rb-plan-reason">
              {r.reason}
            </Text>
          ) : null}
          {r.error ? (
            <Text size="xs" c="red">
              {r.error}
            </Text>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/** The one button of a state without a draft to apply. */
const LONE: Partial<Record<string, { label: string; event: PlanEvent }>> = {
  replanning: { label: 'Cancel', event: { type: 'plan.cancel' } },
  applied: { label: 'OK', event: { type: 'plan.dismiss' } },
}

/** Beside Discard: how a stale, partly failed or unknown draft goes on (else Apply). */
const NEXT: Partial<Record<string, { label: string; event: PlanEvent | null }>> = {
  /** null: the re-based draft (plan.reconfirm) from the tickets as they are now. */
  stale: { label: 'Review again', event: null },
  partiallyFailed: { label: 'Retry', event: { type: 'plan.retry' } },
  unknown: { label: 'Check again', event: { type: 'plan.check' } },
}

function PlanActions({ plan, onReconfirm }: { plan: PlanHandle; onReconfirm(): void }) {
  const { snap, send } = plan
  const state = String(snap.value)
  const lone = LONE[state]
  if (lone)
    return (
      <Button size="xs" variant="subtle" onClick={() => send(lone.event)}>
        {lone.label}
      </Button>
    )
  const next = NEXT[state] ?? { label: 'Apply', event: { type: 'plan.apply' } }
  return (
    <Group gap="xs">
      <Button
        size="xs"
        variant="subtle"
        color="gray"
        disabled={!snap.can({ type: 'plan.discard' })}
        onClick={() => send({ type: 'plan.discard' })}
      >
        Discard
      </Button>
      <Button
        size="xs"
        disabled={next.event !== null && !snap.can(next.event)}
        onClick={() => (next.event ? send(next.event) : onReconfirm())}
      >
        {next.label}
      </Button>
    </Group>
  )
}

/** The draft's strip above the chart: what changes, why, and Apply / Discard. */
export function PlanPanel({
  plan,
  deltas,
  onOpen,
  onReconfirm,
}: {
  plan: PlanHandle
  deltas: ReadonlyMap<string, number>
  onOpen(key: string): void
  onReconfirm(): void
}) {
  const head = headOf(plan)
  const { message, rows } = plan.snap.context
  if (!head && !message) return null
  return (
    <section className="rb-plan" data-testid="plan-panel" data-plan={String(plan.snap.value)}>
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Group gap="xs" wrap="nowrap" miw={0}>
          {head?.busy ? <Loader size="xs" /> : null}
          <Text size="sm" fw={600} truncate>
            {head?.title ?? ''}
          </Text>
        </Group>
        {head ? <PlanActions plan={plan} onReconfirm={onReconfirm} /> : null}
      </Group>
      {message ? (
        <Text size="xs" c="red" data-testid="plan-message">
          {message}
        </Text>
      ) : null}
      {rows.length > 0 ? <PlanRows rows={rows} deltas={deltas} onOpen={onOpen} /> : null}
      <PlanConfirm plan={plan} />
    </section>
  )
}

/** Apply's confirm: every change, key, field, old -> new. */
function PlanConfirm({ plan }: { plan: PlanHandle }) {
  const { snap, send } = plan
  const changes = changesOf(snap.context.rows)
  const close = (): void => send({ type: 'plan.back' })
  return (
    <EvaModal
      opened={snap.matches('confirming')}
      onClose={close}
      title="Apply this plan?"
      size={560}
      testid="plan-confirm"
    >
      <Text size="sm" mb="sm">
        Due dates, priorities and order are written to Linear as you. Starts stay in Relay.
      </Text>
      <Table className="rb-plan-table" withRowBorders={false}>
        <Table.Tbody>
          {changes.map((c) => (
            <Table.Tr key={`${c.key}:${c.field}`}>
              <Table.Td>{c.key}</Table.Td>
              <Table.Td>{c.field}</Table.Td>
              <Table.Td>
                {c.from} → {c.to}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Group justify="flex-end" gap="xs" mt="md">
        <Button variant="subtle" color="gray" onClick={close}>
          Cancel
        </Button>
        <Button onClick={() => send({ type: 'plan.confirm' })} data-testid="plan-confirm-apply">
          Apply {changes.length} {changes.length === 1 ? 'change' : 'changes'}
        </Button>
      </Group>
    </EvaModal>
  )
}
