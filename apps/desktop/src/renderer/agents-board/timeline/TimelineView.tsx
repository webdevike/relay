import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
} from 'react'
import {
  Gantt,
  WillowDark,
  type IApi,
  type IColumnConfig,
  type IScaleConfig,
  type ITask,
  type TID,
} from '@svar-ui/react-gantt'
import '@svar-ui/react-gantt/all.css'
import { SegmentedControl, Text, UnstyledButton } from '@mantine/core'
import { useElementSize } from '@mantine/hooks'
import type { TicketBoardFacts } from '@relay/protocol'
import { ChartOverlay, DateLines } from './DateLines'
import { OrderBadge, PlanGhosts, PlanPanel, ReplanButton } from './PlanDiff'
import { usePlan, type PlanDeps, type PlanHandle } from './plan-actor'
import {
  addDays,
  barOfGantt,
  dateOfDay,
  dayOfMs,
  dragEdit,
  placeAt,
  rebaseRows,
  type PlanTicket,
} from './plan-rules'
import type { ReplanScope } from './plan.machine'
import { buildTimeline, ghostsOf, type TimelineModel, type TimelineTask } from './timeline-model'
import './timeline.css'

type Zoom = 'week' | 'month' | 'quarter'
const ZOOMS: readonly Zoom[] = ['week', 'month', 'quarter']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// cellWidth is per smallest scale unit; lengthUnit 'day' keeps drag/resize snapping to days.
const PRESETS: Record<Zoom, { cellWidth: number; scales: IScaleConfig[] }> = {
  week: {
    cellWidth: 84,
    scales: [
      { unit: 'month', step: 1, format: '%F %Y' },
      { unit: 'week', step: 1, format: (d: Date) => `${d.getDate()} ${MON[d.getMonth()]}` },
    ],
  },
  month: {
    cellWidth: 150,
    scales: [
      { unit: 'year', step: 1, format: '%Y' },
      { unit: 'month', step: 1, format: '%F' },
    ],
  },
  quarter: {
    cellWidth: 220,
    scales: [
      { unit: 'year', step: 1, format: '%Y' },
      {
        unit: 'quarter',
        step: 1,
        format: (d: Date) => `Q${Math.floor(d.getMonth() / 3) + 1}`,
      },
    ],
  },
}
const ZOOM_DATA = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
]
const PANEL_DATA = [
  { value: 'grid', label: 'Rows' },
  { value: 'chart', label: 'Chart' },
]
const KEY_ZOOM: Partial<Record<string, Zoom>> = {
  w: 'week',
  m: 'month',
  q: 'quarter',
  '1': 'week',
  '2': 'month',
  '3': 'quarter',
}
const KEY_STEP: Partial<Record<string, number>> = { '-': 1, _: 1, '=': -1, '+': -1 }
/** A click this soon after a row reorder is the reorder's own mouseup, not an open. */
const REORDER_CLICK_MS = 400

const READ_ONLY_STATES: Partial<Record<string, true>> = {
  replanning: true,
  confirming: true,
  applying: true,
  stale: true,
}

/** The draft's order badge beside a ticket row's title. */
function PlanCell({ row }: { row: Partial<TimelineTask> }) {
  return row.delta ? <OrderBadge delta={row.delta} /> : null
}

const COLUMNS = [
  { id: 'text', header: 'Project / milestone / ticket', flexgrow: 1 },
  { id: 'plan', header: '', width: 52, cell: PlanCell },
] as unknown as IColumnConfig[]

interface Live {
  model: TimelineModel
  tickets: readonly PlanTicket[]
  plan: PlanHandle
  onOpen(key: string): void
  setScope(scope: ReplanScope): void
  reorderedAt: number
}

/** The re-plan scope of a row: its milestone (or the project for a project row). */
function scopeOf(model: TimelineModel, id: string, parent: TID | undefined): ReplanScope | null {
  const groupId = id.startsWith('p:') || id.startsWith('m:') ? id : String(parent)
  const m = model.milestones.find((x) => x.id === groupId || `p:${x.projectId ?? ''}` === groupId)
  if (!m?.projectId) return null
  if (groupId.startsWith('p:')) return { projectId: m.projectId, label: m.label.split(' / ')[0]! }
  return m.milestoneId
    ? { projectId: m.projectId, milestoneId: m.milestoneId, label: m.label }
    : { projectId: m.projectId, label: m.label }
}

/** A drag or resize ended: the change goes into the draft (the bar returns to Linear's dates). */
function onDrag(a: IApi, live: Live, id: TID): void {
  const t = live.tickets.find((x) => x.key === id)
  const before = live.model.bars[String(id)]
  const task = a.getTask(id)
  if (!t || !before || !task.start || !task.end) return
  const patch = dragEdit(before, barOfGantt(task.start, task.end))
  if (Object.keys(patch).length > 0) live.plan.edit(t, patch)
}

/** A row reorder ended: priority/order from its new neighbors in the milestone. */
function onReorder(a: IApi, live: Live, id: TID): void {
  live.reorderedAt = Date.now()
  const t = live.tickets.find((x) => x.key === id)
  const parent = a.getTask(id).parent
  if (!t || parent === undefined) return
  const order = (a.getTask(parent).data ?? []).map((s) => String(s.id))
  const rest = order
    .filter((k) => k !== id)
    .map((k) => live.tickets.find((x) => x.key === k))
    .filter((x): x is PlanTicket => x !== undefined)
  live.plan.edit(t, placeAt(t, rest, order.indexOf(String(id))))
}

function onSelect(a: IApi, live: Live, id: TID, click: boolean): void {
  const task = a.getTask(id)
  const scope = scopeOf(live.model, String(id), task.parent)
  if (scope) live.setScope(scope)
  const recent = Date.now() - live.reorderedAt < REORDER_CLICK_MS
  if (click && task.type !== 'summary' && !recent) live.onOpen(String(id))
}

const isSummary = (a: IApi, id: TID | undefined): boolean =>
  id === undefined || a.getTask(id)?.type === 'summary'

/** Summaries are computed rows: never dragged or reordered; tickets reorder within their milestone. */
function wire(a: IApi, ref: MutableRefObject<Live>): void {
  a.intercept(
    'drag-task',
    (ev) => !(isSummary(a, ev.id) && (ev.left !== undefined || ev.width !== undefined)),
  )
  a.intercept('move-task', (ev) => {
    if (isSummary(a, ev.id) || ev.mode === 'child') return false
    return ev.target === undefined || a.getTask(ev.target)?.parent === a.getTask(ev.id).parent
  })
  // The store also re-derives summary dates and emits update-task without `diff` for them.
  a.on('update-task', (ev) => {
    if (!ev.inProgress && ev.diff !== undefined) onDrag(a, ref.current, ev.id)
  })
  a.on('move-task', (ev) => {
    if (!ev.inProgress) onReorder(a, ref.current, ev.id)
  })
  a.on('select-task', (ev) => onSelect(a, ref.current, ev.id, ev.toggle === false))
}

export interface TimelineViewProps {
  tickets: TicketBoardFacts[]
  onOpen(key: string): void
  /** The host's plan routes (`tickets.plan`, `tickets.replan`) and test seams. */
  plan?: Partial<PlanDeps>
}

function zoomKeys(setZoom: (f: (z: Zoom) => Zoom) => void) {
  return (e: KeyboardEvent): void => {
    const el = e.target as HTMLElement
    if (el.closest('input, textarea, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey)
      return
    const zoom = KEY_ZOOM[e.key]
    const step = KEY_STEP[e.key]
    if (!zoom && step === undefined) return
    e.preventDefault()
    setZoom((z) => zoom ?? ZOOMS[Math.min(2, Math.max(0, ZOOMS.indexOf(z) + step!))]!)
  }
}

function NoDateList({ model, onOpen }: { model: TimelineModel; onOpen(key: string): void }) {
  if (model.noDate.length === 0) return null
  return (
    <aside className="rb-timeline-nodate" data-testid="timeline-nodate">
      <Text size="xs" fw={600} c="dimmed">
        No date ({model.noDate.length})
      </Text>
      {model.noDate.map((n) => (
        <UnstyledButton key={n.key} className="rb-nodate-item" onClick={() => onOpen(n.key)}>
          <Text size="xs" truncate>
            {n.key} {n.title}
          </Text>
          <Text size="xs" c="dimmed" truncate>
            {n.group}
          </Text>
        </UnstyledButton>
      ))}
    </aside>
  )
}

/** The Board's Timeline: project, milestone, tickets on SVAR Gantt, with the plan draft. */
export function TimelineView({ tickets, onOpen, plan: deps }: TimelineViewProps) {
  const plan = usePlan(deps)
  const rows = plan.snap.context.rows
  const [today] = useState(() => dayOfMs(Date.now()))
  const model = useMemo(() => buildTimeline(tickets, today, rows), [tickets, today, rows])
  const ghosts = useMemo(() => ghostsOf(model, rows), [model, rows])
  const deltas = useMemo(
    () => new Map(model.tasks.flatMap((t) => (t.delta ? [[t.id, t.delta] as const] : []))),
    [model],
  )
  const [zoom, setZoom] = useState<Zoom>('week')
  const [panel, setPanel] = useState<'chart' | 'grid'>('chart')
  const [scope, setScope] = useState<ReplanScope | null>(null)
  const [api, setApi] = useState<IApi | null>(null)
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const { ref, width } = useElementSize()
  const narrow = width > 0 && width <= 650
  const live = useRef<Live>({ model, tickets, plan, onOpen, setScope, reorderedAt: 0 })
  Object.assign(live.current, { model, tickets, plan, onOpen })
  const init = useCallback(
    (a: IApi) => {
      wire(a, live)
      const from = dateOfDay(addDays(today, -7))
      requestAnimationFrame(() => void a.exec('scroll-chart', { date: from }))
      setApi(a)
    },
    [today],
  )
  const onKey = zoomKeys(setZoom)
  // While Astra re-plans, the confirm is open, rows write or the draft is stale: no edits.
  const busy = READ_ONLY_STATES[String(plan.snap.value)] === true
  const preset = PRESETS[zoom]
  const reconfirm = (): void =>
    plan.send({ type: 'plan.reconfirm', rows: rebaseRows(rows, tickets) })
  return (
    <div
      className="rb-timeline"
      tabIndex={0}
      onKeyDown={onKey}
      data-testid="timeline"
      data-zoom={zoom}
      data-narrow={narrow || undefined}
    >
      <div className="rb-timeline-bar">
        <SegmentedControl
          size="xs"
          value={zoom}
          onChange={(v) => setZoom(v as Zoom)}
          data={ZOOM_DATA}
        />
        {narrow ? (
          <SegmentedControl
            size="xs"
            value={panel}
            onChange={(v) => setPanel(v as 'chart' | 'grid')}
            data={PANEL_DATA}
          />
        ) : null}
        <Text size="xs" c="dimmed" className="rb-timeline-hint">
          W / M / Q or - / = to zoom
        </Text>
        <ReplanButton plan={plan} scope={scope} />
      </div>
      <PlanPanel plan={plan} deltas={deltas} onOpen={onOpen} onReconfirm={reconfirm} />
      <div className="rb-timeline-body">
        <div
          className="rb-timeline-chart"
          ref={(n) => {
            ref(n)
            setHost(n)
          }}
        >
          <WillowDark fonts={false}>
            <Gantt
              tasks={model.tasks as unknown as ITask[]}
              links={[]}
              columns={COLUMNS}
              init={init}
              start={model.start}
              end={model.end}
              lengthUnit="day"
              scales={preset.scales}
              cellWidth={preset.cellWidth}
              cellHeight={34}
              scaleHeight={28}
              gridWidth={340}
              readonly={busy}
              displayMode={narrow ? [panel] : ['grid', 'chart']}
            />
          </WillowDark>
          {api && host ? (
            <ChartOverlay
              api={api}
              host={host}
              layoutKey={`${zoom}:${narrow}:${panel}`}
              render={(area) => (
                <>
                  <DateLines lines={model.lines} area={area} />
                  <PlanGhosts ghosts={ghosts} area={area} />
                </>
              )}
            />
          ) : null}
        </div>
        <NoDateList model={model} onOpen={onOpen} />
      </div>
    </div>
  )
}
