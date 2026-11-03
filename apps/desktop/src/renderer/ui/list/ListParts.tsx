import { Tooltip, VisuallyHidden, Badge } from '@mantine/core'
import {
  IconAlertCircle,
  IconCircle,
  IconCircleCheck,
  IconCircleDot,
  IconClock,
  IconInfoCircle,
  IconProgress,
} from '@tabler/icons-react'
import type { ReactNode } from 'react'

/** What a pill says about its value; color is paired with the label, never alone. */
export type ListTone = 'ok' | 'bad' | 'warn' | 'info' | 'accent' | 'dim'

const TONE_COLOR: Record<ListTone, string> = {
  ok: 'green',
  bad: 'red',
  warn: 'yellow',
  info: 'blue',
  accent: 'violet',
  dim: 'gray',
}

/** A quiet status pill for a row's trailing slot or a column cell. */
export function ListPill({
  tone,
  icon,
  children,
  'data-testid': testid,
}: {
  tone: ListTone
  icon?: ReactNode
  children: ReactNode
  'data-testid'?: string
}) {
  return (
    <Badge
      className="eva-list-pill"
      variant="light"
      color={TONE_COLOR[tone]}
      radius="xl"
      size="sm"
      tt="none"
      leftSection={icon}
      data-tone={tone}
      data-testid={testid}
    >
      {children}
    </Badge>
  )
}

const TONE_ICON: Record<ListTone, ReactNode> = {
  ok: <IconCircleCheck size={16} stroke={1.5} aria-hidden />,
  bad: <IconAlertCircle size={16} stroke={1.5} aria-hidden />,
  warn: <IconClock size={16} stroke={1.5} aria-hidden />,
  info: <IconProgress size={16} stroke={1.5} aria-hidden />,
  accent: <IconCircleDot size={16} stroke={1.5} aria-hidden />,
  dim: <IconCircle size={16} stroke={1.5} aria-hidden />,
}

export interface ListMarkProps {
  /** The status in words: the tooltip, and screen-reader text. */
  label: string
  tone: ListTone
  /** Replaces the tone's default icon (a spinner for something running). */
  icon?: ReactNode
  'data-testid'?: string
}

/**
 * One status of a row as an icon in its tone, its words in the tooltip. The words also sit in
 * the DOM for screen readers.
 */
export function ListStatus({ label, tone, icon, 'data-testid': testid }: ListMarkProps) {
  return (
    <Tooltip label={label} openDelay={200}>
      {/* An empty title keeps the row's own tooltip from stacking on this one. */}
      <span className="eva-list-status" data-tone={tone} title="" data-testid={testid}>
        {icon ?? TONE_ICON[tone]}
        <VisuallyHidden component="span">{label}</VisuallyHidden>
      </span>
    </Tooltip>
  )
}

/**
 * A row's statuses as fixed icon slots, the same slots on every row so a column of icons scans
 * down the list. A slot with no status is empty but keeps its width.
 */
export function ListMarks({
  slots,
  'data-testid': testid,
}: {
  slots: ReadonlyArray<ListMarkProps | null>
  'data-testid'?: string
}) {
  return (
    <span className="eva-list-marks" data-testid={testid}>
      {slots.map((m, i) =>
        m ? (
          <ListStatus key={i} {...m} />
        ) : (
          <span key={i} className="eva-list-status" aria-hidden />
        ),
      )}
    </span>
  )
}

/** The row's age or time, right-aligned in a fixed lane so a column of them lines up. */
export function ListTime({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="eva-list-time" title={title}>
      {children}
    </span>
  )
}

/** The list's empty or error state: an icon, one line that says what is true, a hint, an action. */
export function ListEmpty({
  icon,
  title,
  children,
  action,
  role,
  'data-testid': testid,
}: {
  icon?: ReactNode
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
  role?: 'alert' | 'status'
  'data-testid'?: string
}) {
  return (
    <div className="eva-list-empty" role={role} data-testid={testid}>
      {icon ? <span className="eva-list-empty-icon">{icon}</span> : null}
      {title ? <h2 className="eva-list-empty-title">{title}</h2> : null}
      {children ? <p className="eva-list-empty-hint">{children}</p> : null}
      {action ?? null}
    </div>
  )
}

export interface ListKpi {
  label: ReactNode
  value: ReactNode
  /** A pill beside the label saying how the number reads (Locked, On track). */
  pill?: { tone: ListTone; label: ReactNode }
  'data-testid'?: string
}
/**
 * Option D's KPI strip for ListView's header slot: big numbers over small labels, no cards.
 * `items` are the few that matter and stay visible; `more` are read off an info icon's tooltip.
 */
export function ListKpis({
  items,
  more,
  'data-testid': testid,
  ...rest
}: {
  items: readonly ListKpi[]
  more?: readonly ListKpi[]
  'data-testid'?: string
} & Record<`data-${string}`, string | undefined>) {
  const extra = (more ?? []).map(
    (k) => `${k.label}: ${k.value}${k.pill ? ` (${k.pill.label})` : ''}`,
  )
  return (
    <div className="eva-list-kpis" data-testid={testid} {...rest}>
      {items.map((k, i) => (
        <div key={i} className="eva-list-kpi" data-testid={k['data-testid']}>
          <span className="eva-list-kval">{k.value}</span>
          <span className="eva-list-klabel">
            <span>{k.label}</span>
            {k.pill ? <ListPill tone={k.pill.tone}>{k.pill.label}</ListPill> : null}
          </span>
        </div>
      ))}
      {extra.length > 0 ? (
        <Tooltip label={extra.join(' · ')} openDelay={200} multiline maw={320}>
          <span
            className="eva-list-kmore"
            role="img"
            aria-label={extra.join(', ')}
            data-testid="list-kpis-more"
          >
            <IconInfoCircle size={16} stroke={1.5} aria-hidden />
          </span>
        </Tooltip>
      ) : null}
    </div>
  )
}
