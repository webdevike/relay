import type { ReactNode } from 'react'
import {
  IconAlertCircle,
  IconCircleCheck,
  IconHandStop,
  IconLayout,
  IconMessage,
  IconSubtask,
  IconTerminal2,
} from '@tabler/icons-react'
import {
  ACTIVITY_KIND_LABEL,
  type ActivityItem,
  type ActivityKind,
} from '@evaos/chat-core/activity'
import { etaProps, etaTrailing, useEtaFill, type EtaFill } from '../activity/eta'
import { ListRow, ListTime, rowTip } from '../ui/list'
import { ageText, whenText } from './artifacts-model'

/** One icon per kind, on the Working rows and on the composer chips. */
export const KIND_ICON: Readonly<Record<ActivityKind, typeof IconSubtask>> = {
  helper: IconSubtask,
  session: IconMessage,
  harness: IconTerminal2,
  canvas: IconLayout,
}

/** The kind's icon and label (`Helper`, `Session`, `Harness`, `Canvas`). */
export function KindTag({ kind }: { kind: ActivityKind }) {
  const Icon = KIND_ICON[kind]
  return (
    <span className="eva-art-kind" data-kind={kind}>
      <Icon size={12} stroke={1.5} aria-hidden="true" />
      {ACTIVITY_KIND_LABEL[kind]}
    </span>
  )
}

/** The status mark a row leads with. */
export function StatusMark({ status }: { status: ActivityItem['status'] }) {
  if (status === 'working') return <span className="eva-spinner" aria-label="Running" />
  if (status === 'waiting') {
    return <IconHandStop size={16} stroke={1.5} data-tone="orange" aria-label="Waiting on you" />
  }
  if (status === 'failed') {
    return <IconAlertCircle size={16} stroke={1.5} data-tone="red" aria-label="Failed" />
  }
  return <IconCircleCheck size={16} stroke={1.5} data-tone="green" aria-label="Done" />
}

/** Dollars as a person says them: `$0.42`. */
export const costText = (usd: number): string => `$${usd.toFixed(2)}`

/** A row's meta line: the kind, then the live intent (a waiting item's is the question). */
export function KindMeta({ kind, intent }: { kind: ActivityKind; intent: string }): ReactNode {
  return (
    <span className="eva-art-meta-line">
      <KindTag kind={kind} />
      {intent === '' ? null : <span className="eva-art-intent">{intent}</span>}
    </span>
  )
}

/** What a running row with an estimate adds: the fill's class, attributes and custom properties. */
export function etaRowProps(fill: EtaFill | null, color?: string) {
  return fill === null ? {} : { className: 'eva-eta', ...etaProps(fill, color) }
}

/**
 * One row of the Working tab for anything the host's activity list holds: kind icon and label,
 * the title, the live intent line, the time running (or when it ended). Model and cost are only in
 * the hover text.
 */
export function ActivityRow({
  item,
  now,
  color,
  onOpen,
}: {
  item: ActivityItem
  now: number
  /** The owning assistant's color for the fill; the accent when unset. */
  color?: string
  onOpen: (item: ActivityItem) => void
}) {
  const live = item.status === 'working' || item.status === 'waiting'
  const fill = useEtaFill(item)
  const left = fill === null ? null : etaTrailing(fill.view)
  return (
    <ListRow
      data-testid={`activity-row-${item.id}`}
      data-state={item.status}
      data-kind={item.kind}
      leading={<StatusMark status={item.status} />}
      title={item.title}
      meta={<KindMeta kind={item.kind} intent={item.intent} />}
      tooltip={rowTip(
        item.title,
        item.intent,
        item.model !== undefined && `Model: ${item.model}`,
        item.cost !== undefined && `Spent: ${costText(item.cost)}`,
        ...(fill === null ? [] : [fill.view.label, fill.view.detail]),
      )}
      trailing={
        <ListTime>
          {left ?? (live ? ageText(item.startedAt, now) : whenText(item.updatedAt, now))}
        </ListTime>
      }
      {...etaRowProps(fill, color)}
      onActivate={() => onOpen(item)}
    />
  )
}
