import { Badge } from '@mantine/core'
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

/** Option D's KPI strip for ListView's header slot: big numbers over small labels, no cards. */
export function ListKpis({
  items,
  'data-testid': testid,
  ...rest
}: {
  items: readonly ListKpi[]
  'data-testid'?: string
} & Record<`data-${string}`, string | undefined>) {
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
    </div>
  )
}
