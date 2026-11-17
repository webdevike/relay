import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ActionIcon, Tabs, Tooltip } from '@mantine/core'
import { IconArrowLeft, IconLoader2, IconRosette } from '@tabler/icons-react'
import type { Place } from '@evaos/shell-core'
import type { SpecialistAgent } from '@evaos/contract'
import { agentLabel } from '@relay/protocol'
import { agoLabel } from '@evaos/eva-core/model/jobs'
import {
  ListEmpty,
  ListPill,
  ListRow,
  ListTime,
  ListView,
  rowTip,
  type ListColumn,
} from '../ui/list'
import { AgentPanel, BOARD_MIN, PANEL_MIN } from '../agents-board/AgentPanel'
import { DISMISS_PRIORITY, useDismissable } from '../hotkeys/dismiss'
import { AgentFiles } from './AgentFiles'
import { AgentRuns, SpecialistRunView } from './AgentRuns'
import {
  collapseRunPanel,
  openAgent,
  selectRun,
  setAgentTab,
  startSpecialists,
  useSpecialists,
  type AgentTab,
} from './specialists-store'
import { agentStatus, agentsSummary, modelName } from './specialists-view'
import '../agents-board/agents-board.css'
import './specialists.css'

const COLUMNS: readonly ListColumn[] = [
  { id: 'agent', label: 'Agent', width: 'minmax(0, 3fr)' },
  { id: 'model', label: 'Model', width: 'minmax(0, 1.3fr)' },
  { id: 'status', label: 'Status', width: 'minmax(0, 0.9fr)' },
  { id: 'week', label: 'Runs this week', align: 'end', width: 'minmax(0, 0.9fr)' },
  { id: 'last', label: 'Last run', align: 'end', width: 'minmax(0, 0.9fr)' },
]

/** Re-renders every 30 s, so "5m ago" stays true between reads. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])
  return now
}

/** The page's width, followed as the window or the panes around it resize. */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [ref])
  return width
}

function StatusPill({ agent }: { agent: SpecialistAgent }) {
  const status = agentStatus(agent)
  if (status === null) return null
  return (
    <ListPill
      tone={status.tone}
      icon={
        agent.runs.running > 0 ? (
          <IconLoader2 size={12} stroke={1.5} className="eva-sp-spin" aria-hidden />
        ) : undefined
      }
      data-testid={`agent-status-${agent.id}`}
    >
      {status.label}
    </ListPill>
  )
}

/** Every agent the service loads, one row each; a row opens its files and runs. */
function AgentList({ now }: { now: number }) {
  const roster = useSpecialists((s) => s.roster)
  const error = useSpecialists((s) => s.error)
  if (roster === null && error !== null)
    return (
      <ListEmpty role="alert" data-testid="agents-error" title="Could not read the agents">
        {error}
      </ListEmpty>
    )
  if (roster !== null && !roster.available)
    return (
      <ListEmpty
        data-testid="agents-unavailable"
        icon={<IconRosette size={24} stroke={1.5} />}
        title="No specialist service here"
      >
        The agents come from the atomic-agents service on the Mac that runs your assistants.
      </ListEmpty>
    )
  return (
    <div className="eva-sp" data-testid="agents-list">
      {roster?.error ? (
        <ListEmpty role="alert" data-testid="agents-error" title="Could not read the agents">
          {roster.error}
        </ListEmpty>
      ) : null}
      <ListView
        columns={COLUMNS}
        groups={[{ id: 'agents', items: roster?.agents ?? [] }]}
        rowKey={(a) => a.id}
        loading={roster === null ? { label: 'Loading the agents' } : false}
        renderRow={(a) => (
          <ListRow
            key={a.id}
            data-testid={`agent-row-${a.id}`}
            title={agentLabel(a.id)}
            meta={a.purpose}
            dim={!a.enabled || a.mode === 'off'}
            tooltip={rowTip(
              a.purpose,
              a.fallbackModel === null ? a.model : `${a.model}, falls back to ${a.fallbackModel}`,
              a.trial.on ? `On trial: ${a.trial.arms.join(', ')}` : null,
              a.error,
              a.runs.failed > 0 ? `${String(a.runs.failed)} failed this week` : null,
            )}
            cells={[
              <span key="model" className="eva-sp-model">
                {a.model === '' ? null : modelName(a.model)}
              </span>,
              <StatusPill key="status" agent={a} />,
              <span key="week" className="eva-sp-num" data-testid={`agent-week-${a.id}`}>
                {a.runs.week}
              </span>,
              <ListTime
                key="last"
                title={
                  a.runs.lastAt === null ? undefined : new Date(a.runs.lastAt).toLocaleString()
                }
              >
                {a.runs.lastAt === null ? null : agoLabel(a.runs.lastAt, now)}
              </ListTime>,
            ]}
            onActivate={() => openAgent(a.id)}
          />
        )}
        empty={
          <ListEmpty
            data-testid="agents-empty"
            icon={<IconRosette size={24} stroke={1.5} />}
            title="No agents yet"
          >
            Agents load from the service's domains folder and from its own agents folder.
          </ListEmpty>
        }
      />
    </div>
  )
}

/** One fact about the agent: a quiet label, then its value. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="eva-sp-fact">
      <span className="eva-sp-fact-label">{label}</span>
      <span className="eva-sp-fact-value">{children}</span>
    </span>
  )
}

/** One agent: its name and purpose, model, fallback and status, then its files or its runs. */
function AgentDetail({ agent, now }: { agent: string; now: number }) {
  const entry = useSpecialists((s) => s.roster?.agents.find((a) => a.id === agent) ?? null)
  const tab = useSpecialists((s) => s.tab)
  const week = entry?.runs.week ?? 0
  return (
    <div className="eva-sp-detail" data-testid="agent-detail">
      <header className="eva-sp-detail-head">
        <Tooltip label="All agents" openDelay={300}>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label="All agents"
            data-testid="agent-back"
            onClick={() => openAgent(null)}
          >
            <IconArrowLeft size={18} stroke={1.5} />
          </ActionIcon>
        </Tooltip>
        <div className="eva-sp-detail-title">
          <h1 className="eva-ab-title" data-page-title>
            {agentLabel(agent)}
          </h1>
          {entry ? <p className="eva-sp-purpose">{entry.purpose}</p> : null}
          {entry ? (
            <div className="eva-sp-facts" data-testid="agent-facts">
              <Fact label="Model">{entry.model === '' ? 'None' : modelName(entry.model)}</Fact>
              <Fact label="Fallback">
                {entry.fallbackModel === null ? 'None' : modelName(entry.fallbackModel)}
              </Fact>
              <Fact label="Mode">
                {!entry.enabled || entry.mode === 'off'
                  ? 'Off'
                  : entry.mode === 'shadow'
                    ? 'Shadow (runs, nothing acts on it)'
                    : 'Live'}
              </Fact>
              <Fact label="Trial">
                {entry.trial.on ? `On: ${entry.trial.arms.map(modelName).join(', ')}` : 'Off'}
              </Fact>
              {/* Mode and Trial already say off, shadow or trial; the pill adds only running or not loading. */}
              {entry.runs.running > 0 || entry.error !== null ? <StatusPill agent={entry} /> : null}
            </div>
          ) : null}
          {entry?.error ? (
            <div className="eva-sp-loaderror" role="alert" data-testid="agent-load-error">
              {entry.error}
            </div>
          ) : null}
        </div>
      </header>
      <Tabs
        value={tab}
        onChange={(v) => setAgentTab((v as AgentTab | null) ?? 'files')}
        className="eva-sp-tabs"
        keepMounted={false}
      >
        <Tabs.List>
          <Tabs.Tab value="files" data-testid="agent-tab-files">
            Files
          </Tabs.Tab>
          <Tabs.Tab value="runs" data-testid="agent-tab-runs">
            {week > 0 ? `Runs (${String(week)} this week)` : 'Runs'}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="files" className="eva-sp-tabpanel">
          <AgentFiles agent={agent} />
        </Tabs.Panel>
        <Tabs.Panel value="runs" className="eva-sp-tabpanel">
          <AgentRuns agent={agent} now={now} />
        </Tabs.Panel>
      </Tabs>
    </div>
  )
}

/**
 * The Agents page: the atomic-agents specialists (`atomic-agents list --json`), each with its
 * purpose, model, status and runs this week. A row opens the agent: its folder in the Files tree
 * and editor (saved live, committed to the repo) and its runs with their output beside them.
 */
export function AgentsPage(_props: { place: Place }) {
  useEffect(() => startSpecialists(), [])
  const roster = useSpecialists((s) => s.roster)
  const agent = useSpecialists((s) => s.agent)
  const tab = useSpecialists((s) => s.tab)
  const runId = useSpecialists((s) => s.run)
  const collapsed = useSpecialists((s) => s.collapsed)
  const runs = useSpecialists((s) => (s.agent === null ? null : (s.runs[s.agent] ?? null)))
  const now = useNow()
  const page = useRef<HTMLDivElement>(null)
  const pageWidth = useWidth(page)
  const narrow = pageWidth > 0 && pageWidth < BOARD_MIN + PANEL_MIN
  const run =
    agent === null || tab !== 'runs' || runId === null
      ? null
      : (runs?.runs.find((r) => r.run === runId) ?? null)
  // Esc closes the run panel (the drawer closes itself).
  useDismissable(DISMISS_PRIORITY.selection, () => selectRun(null), run !== null && !narrow)

  return (
    <div className="eva-ab" ref={page} data-testid="page-agents">
      <div className="eva-ab-main">
        {agent === null ? (
          <>
            <header className="eva-ab-head">
              <div className="eva-ab-heading">
                <h1 className="eva-ab-title" data-page-title>
                  Agents
                </h1>
                {roster?.available ? (
                  <span className="eva-ab-summary" data-testid="agents-summary">
                    {agentsSummary(roster.agents)}
                  </span>
                ) : null}
              </div>
            </header>
            <AgentList now={now} />
          </>
        ) : (
          <AgentDetail agent={agent} now={now} />
        )}
      </div>
      <AgentPanel
        open={run ? { key: run.run, label: run.summary ?? agentLabel(run.agent) } : null}
        narrow={narrow}
        pageWidth={pageWidth}
        collapsed={collapsed}
        onCollapse={collapseRunPanel}
        onClose={() => selectRun(null)}
      >
        {(chrome) =>
          run === null ? null : <SpecialistRunView key={run.run} run={run} now={now} {...chrome} />
        }
      </AgentPanel>
    </div>
  )
}
