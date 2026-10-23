import './widgets.css'
import { Component, useMemo, type ComponentType, type ReactNode } from 'react'
import {
  parseWidget,
  type StatSpec,
  type WidgetKind,
  type WidgetSpec,
} from '@evaos/chat-core/widget'
import { parseOpenUI } from '@evaos/chat-core/openui'
import { CodeBlock } from '../markdown/CodeBlock'
import { ButtonBlock, InputBlock } from './blocks/actions'
import {
  CardBlock,
  CollapseBlock,
  Frame,
  GridBlock,
  StackBlock,
  TabsBlock,
} from './blocks/containers'
import {
  AvatarBlock,
  BadgeBlock,
  CalloutBlock,
  CodeNodeBlock,
  DividerBlock,
  LinkBlock,
  ListBlock,
  ProgressBlock,
  QuoteBlock,
  RowsBlock,
  TextBlock,
  TimelineBlock,
} from './blocks/content'
import { TableBlock } from './blocks/table'
import { AudioWidget } from './rich/AudioWidget'
import { ChartWidget } from './rich/ChartWidget'
import { CompareWidget } from './rich/CompareWidget'
import { DiagramWidget } from './rich/DiagramWidget'
import { DiffWidget } from './rich/DiffWidget'
import { EmailsWidget } from './rich/EmailsWidget'
import { GalleryWidget } from './rich/GalleryWidget'
import { ImageWidget } from './rich/ImageWidget'
import { ModelWidget } from './rich/ModelWidget'
import { PrWidget } from './rich/PrWidget'
import { RecipeWidget } from './rich/RecipeWidget'
import { StatWidget } from './rich/StatWidget'
import { TicketsWidget } from './rich/TicketsWidget'
import { VideoWidget } from './rich/VideoWidget'

type SpecOf<K extends WidgetKind> = Extract<WidgetSpec, { widget: K }>

/** The component that draws each node kind. */
const REGISTRY: { [K in WidgetKind]: ComponentType<{ spec: SpecOf<K> }> } = {
  chart: ChartWidget,
  stat: StatWidget,
  tickets: TicketsWidget,
  compare: CompareWidget,
  audio: AudioWidget,
  video: VideoWidget,
  gallery: GalleryWidget,
  model: ModelWidget,
  diagram: DiagramWidget,
  recipe: RecipeWidget,
  diff: DiffWidget,
  emails: EmailsWidget,
  pr: PrWidget,
  image: ImageWidget,
  text: TextBlock,
  rows: RowsBlock,
  badge: BadgeBlock,
  divider: DividerBlock,
  button: ButtonBlock,
  link: LinkBlock,
  table: TableBlock,
  progress: ProgressBlock,
  list: ListBlock,
  callout: CalloutBlock,
  code: CodeNodeBlock,
  quote: QuoteBlock,
  avatar: AvatarBlock,
  timeline: TimelineBlock,
  input: InputBlock,
  stack: StackBlock,
  card: CardBlock,
  grid: GridBlock,
  tabs: TabsBlock,
  collapse: CollapseBlock,
}

/** One node of a widget tree; containers render their children through this again. */
export function WidgetNode({ spec }: { spec: WidgetSpec }) {
  const Render = REGISTRY[spec.widget] as ComponentType<{ spec: WidgetSpec }>
  return <Render spec={spec} />
}

/** Kinds that sit in the reply bare at the root (widgets.rs render): they carry their own
 * structure, or are a card, which is the frame itself. Every other root gets one frame. */
const BARE_AT_ROOT: Partial<Record<WidgetKind, true>> = {
  card: true,
  chart: true,
  emails: true,
  compare: true,
  diff: true,
  button: true,
  link: true,
  image: true,
  table: true,
  progress: true,
  list: true,
  callout: true,
  code: true,
  quote: true,
  avatar: true,
  timeline: true,
  input: true,
  grid: true,
  tabs: true,
  collapse: true,
}

/** A root row of stats: hairlines above and below, one between each pair (widgets.rs render). */
function StatsRow({ stats }: { stats: StatSpec[] }) {
  const Stat = REGISTRY.stat
  return (
    <div className="eva-wb-stats" data-testid="widget-stats-row">
      {stats.map((stat, i) => (
        <div key={i} className="eva-wb-stats-cell">
          <Stat spec={stat} />
        </div>
      ))}
    </div>
  )
}

function WidgetRoot({ spec }: { spec: WidgetSpec }) {
  if (
    spec.widget === 'stack' &&
    spec.direction === 'horizontal' &&
    spec.children.every((c) => c.widget === 'stat')
  ) {
    return <StatsRow stats={spec.children as StatSpec[]} />
  }
  if (BARE_AT_ROOT[spec.widget]) return <WidgetNode spec={spec} />
  return (
    <Frame>
      <WidgetNode spec={spec} />
    </Frame>
  )
}

/** The block a bad ```ui fence shows: its JSON, pretty when it parses, under a warning header. */
function InvalidWidget({ json }: { json: string }) {
  let code = json
  try {
    code = JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    // Not JSON at all: shown as written.
  }
  return <CodeBlock lang="json" code={code} invalid />
}

/** A spec that validated but threw while drawing degrades like one that failed to parse. */
class WidgetBoundary extends Component<
  { source: string; fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidUpdate(prev: { source: string }): void {
    if (prev.source !== this.props.source && this.state.failed) this.setState({ failed: false })
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/** A closed ```ui fence: the widget tree it describes, or its source under a warning header. */
export function WidgetBlock({ json }: { json: string }) {
  const spec = useMemo(() => parseWidget(json), [json])
  const fallback = <InvalidWidget json={json} />
  if (spec === null) return fallback
  return (
    <div className="eva-widget" data-testid="widget" data-widget={spec.widget}>
      <WidgetBoundary source={json} fallback={fallback}>
        <WidgetRoot spec={spec} />
      </WidgetBoundary>
    </div>
  )
}

/**
 * A ```openui fence: OpenUI Lang parsed into the same widget tree a ```ui block draws. While the
 * fence still streams it renders the valid prefix live (plain source until a root renders); once
 * closed, a root that doesn't render shows its source under the warning header.
 */
export function OpenUIBlock({ code, closed }: { code: string; closed: boolean }) {
  const spec = useMemo(() => parseOpenUI(code, { partial: !closed }).node, [code, closed])
  const fallback = <CodeBlock lang="openui" code={code} invalid />
  if (spec === null) return closed ? fallback : <CodeBlock lang="openui" code={code} />
  return (
    <div
      className="eva-widget"
      data-testid="widget"
      data-widget={spec.widget}
      data-partial={!closed || undefined}
    >
      <WidgetBoundary source={code} fallback={fallback}>
        <WidgetRoot spec={spec} />
      </WidgetBoundary>
    </div>
  )
}
