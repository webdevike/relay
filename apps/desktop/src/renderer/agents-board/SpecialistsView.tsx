import { useEffect, useState, type ReactNode } from 'react'
import { Avatar, Tooltip, UnstyledButton } from '@mantine/core'
import {
  IconAlertCircle,
  IconCircleCheck,
  IconLayoutSidebarRightCollapse,
  IconLoader2,
  IconMessage,
  IconRosette,
  IconUserQuestion,
  IconX,
} from '@tabler/icons-react'
import type { Assistant, SpecialistCaller, SpecialistRun } from '@evaos/contract'
import { agentLabel, agentRunOf, type AgentRun } from '@relay/protocol'
import { agoLabel } from '@evaos/eva-core/model/jobs'
import { invoke } from '../ipc'
import { costLabel, RunDetails } from '../chat/AgentsCaption'
import { useAssistants } from '../assistants/assistants-store'
import { portrait } from '../ui/portrait'
import {
  ListEmpty,
  ListRow,
  ListStatus,
  ListTime,
  ListView,
  rowTip,
  type ListColumn,
  type ListTone,
} from '../ui/list'
import type { PanelChrome } from './AgentPanel'
import { selectRun, startSpecialists, useAgentsBoard } from './agents-store'
import { callerAssistant, callerName } from './specialists-view'

const ICON = { size: 16, stroke: 1.5, 'aria-hidden': true } as const
const STATUS: Record<SpecialistRun['status'], { label: string; tone: ListTone; icon: ReactNode }> =
  {
    running: { label: 'Running', tone: 'info', icon: <IconLoader2 {...ICON} /> },
    done: { label: 'Done', tone: 'ok', icon: <IconCircleCheck {...ICON} /> },
    failed: { label: 'Failed', tone: 'bad', icon: <IconAlertCircle {...ICON} /> },
  }
/** A stable empty list, so the assistants selector does not re-render while they load. */
const NO_ASSISTANTS: readonly Assistant[] = []

/** `Web researcher for Nova`, or the specialist alone when nobody said who asked. */
const forWhom = (run: SpecialistRun, assistants: readonly Assistant[]): string =>
  run.caller.kind === 'none'
    ? agentLabel(run.agent)
    : `${agentLabel(run.agent)} for ${callerName(run.caller, assistants)}`

const USAGE_COLUMNS: readonly ListColumn[] = [
  { id: 'agent', label: 'Specialist' },
  { id: 'calls', label: 'Calls', align: 'end', width: 'minmax(0, 0.6fr)' },
  { id: 'callers', label: 'By caller', align: 'start', width: 'minmax(0, 2fr)' },
  { id: 'cost', label: 'Cost', align: 'end', width: 'minmax(0, 0.8fr)' },
]

/** Who asked, as a round face: the assistant's portrait, a chat bubble, or a question mark when nobody said. */
function CallerAvatar({ caller, size }: { caller: SpecialistCaller; size: 'sm' | 'md' }) {
  const assistants = useAssistants((s) => s.data?.agents ?? NO_ASSISTANTS)
  const name = callerName(caller, assistants)
  const assistant = callerAssistant(caller, assistants)
  const glyph = { size: size === 'sm' ? 14 : 18, stroke: 1.5, 'aria-hidden': true } as const
  return (
    <Avatar
      className="eva-sp-avatar"
      size={size}
      radius="xl"
      src={assistant ? portrait(assistant.avatar) : undefined}
      alt={name}
      title={name}
      data-caller={caller.kind}
    >
      {caller.kind === 'chat' ? <IconMessage {...glyph} /> : <IconUserQuestion {...glyph} />}
    </Avatar>
  )
}

/**
 * The Agents page's Specialists view: each specialist's use over the window (calls, who asked,
 * cost) as one divided table, then every recent run newest first, one flat row each (who asked,
 * the request on one line, the specialist, status, cost and age). A row opens its reply in the
 * side panel.
 */
export function SpecialistsView({ now }: { now: number }) {
  useEffect(() => startSpecialists(), [])
  const data = useAgentsBoard((s) => s.specialists)
  const error = useAgentsBoard((s) => s.specialistsError)
  const selected = useAgentsBoard((s) => s.run)
  const assistants = useAssistants((s) => s.data?.agents ?? NO_ASSISTANTS)

  if (data === null && error !== null)
    return (
      <ListEmpty
        role="alert"
        data-testid="specialists-error"
        title="Could not read specialist runs"
      >
        {error}
      </ListEmpty>
    )
  if (data !== null && !data.available)
    return (
      <ListEmpty
        data-testid="specialists-unavailable"
        icon={<IconRosette size={24} stroke={1.5} />}
        title="No specialist service here"
      >
        Specialist runs come from the atomic-agents service on the Mac that runs your assistants.
      </ListEmpty>
    )

  return (
    <div className="eva-sp" data-testid="agents-specialists">
      {data?.error ? (
        <ListEmpty
          role="alert"
          data-testid="specialists-error"
          title="Could not read specialist runs"
        >
          {data.error}
        </ListEmpty>
      ) : null}
      <section className="eva-sp-section" aria-labelledby="eva-sp-usage">
        <h2 className="eva-sp-heading" id="eva-sp-usage">
          Last {data?.days ?? 7} days
        </h2>
        <ListView
          data-testid="specialists-usage"
          density="compact"
          columns={USAGE_COLUMNS}
          groups={[{ id: 'usage', items: data?.agents ?? [] }]}
          rowKey={(u) => u.agent}
          loading={data === null ? { label: 'Loading specialist use' } : false}
          renderRow={(u) => (
            <ListRow
              key={u.agent}
              data-testid={`specialists-usage-${u.agent}`}
              title={agentLabel(u.agent)}
              tooltip={rowTip(
                agentLabel(u.agent),
                u.failed > 0 ? `${String(u.failed)} failed` : null,
              )}
              cells={[
                <span
                  key="calls"
                  className="eva-sp-num"
                  data-testid={`specialists-calls-${u.agent}`}
                >
                  {u.calls}
                </span>,
                <span key="callers" className="eva-sp-callers">
                  {u.callers.map((c, i) => (
                    <span
                      key={i}
                      className="eva-sp-caller"
                      title={`${callerName(c.caller, assistants)}: ${String(c.calls)}`}
                    >
                      <CallerAvatar caller={c.caller} size="sm" />
                      <span className="eva-sp-num">{c.calls}</span>
                    </span>
                  ))}
                </span>,
                <span key="cost" className="eva-sp-num">
                  {u.cost > 0 ? costLabel(u.cost) : null}
                </span>,
              ]}
            />
          )}
          empty={
            <div className="eva-sp-note" data-testid="specialists-usage-empty">
              No specialist was asked in this window.
            </div>
          }
        />
      </section>
      <section className="eva-sp-section" aria-labelledby="eva-sp-runs">
        <h2 className="eva-sp-heading" id="eva-sp-runs">
          Recent runs
        </h2>
        <ListView
          data-testid="specialists-runs"
          groups={[{ id: 'runs', items: data?.runs ?? [] }]}
          rowKey={(r) => r.run}
          loading={data === null ? { label: 'Loading specialist runs' } : false}
          renderRow={(r) => {
            const status = STATUS[r.status]
            return (
              <ListRow
                key={r.run}
                data-testid={`specialists-run-${r.run}`}
                data-status={r.status}
                active={r.run === selected}
                tile={false}
                leading={<CallerAvatar caller={r.caller} size="md" />}
                title={r.summary ?? agentLabel(r.agent)}
                meta={forWhom(r, assistants)}
                tooltip={rowTip(
                  r.summary,
                  forWhom(r, assistants),
                  r.model,
                  r.error,
                  r.at === null ? null : new Date(r.at).toLocaleString(),
                )}
                trailing={
                  <>
                    <span className="eva-sp-num eva-sp-cost" data-testid="specialists-run-cost">
                      {r.cost === null || r.cost === 0 ? null : costLabel(r.cost)}
                    </span>
                    <ListStatus label={status.label} tone={status.tone} icon={status.icon} />
                    <ListTime title={r.at === null ? undefined : new Date(r.at).toLocaleString()}>
                      {r.at === null ? null : agoLabel(r.at, now)}
                    </ListTime>
                  </>
                }
                onActivate={() => selectRun(r.run)}
              />
            )
          }}
          empty={
            <ListEmpty
              data-testid="specialists-empty"
              icon={<IconRosette size={24} stroke={1.5} />}
              title="No specialist runs yet"
            >
              Each time an assistant asks a specialist (web research, design critique, mail triage)
              the run shows up here with who asked and what it cost.
            </ListEmpty>
          }
        />
      </section>
    </div>
  )
}

/** The side panel for one run: who asked and when, then its request and typed reply as the service has it now. */
export function SpecialistRunView({
  run,
  now,
  onClose,
  onCollapse,
}: { run: SpecialistRun; now: number } & PanelChrome) {
  const assistants = useAssistants((s) => s.data?.agents ?? NO_ASSISTANTS)
  const [shown, setShown] = useState<AgentRun | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void invoke('agents.specialistRun', { run: run.run }).then((r) => {
      if (!live) return
      if (!r.ok) return setFailed(r.error.message)
      const read = agentRunOf(
        { tool: 'agents_result', run: run.run, agent: run.agent },
        { text: r.value.text, isError: !r.value.ok },
      )
      if (read) setShown(read)
      else setFailed('The service did not answer with this run')
    })
    return () => {
      live = false
    }
  }, [run.run, run.agent, run.status])

  return (
    <div className="eva-ab-tv" data-testid="specialists-panel">
      <header className="eva-ab-tv-head">
        <CallerAvatar caller={run.caller} size="sm" />
        <span className="eva-sp-panel-who">
          {run.caller.kind === 'none'
            ? agentLabel(run.agent)
            : `${callerName(run.caller, assistants)} asked ${agentLabel(run.agent)}`}
        </span>
        <span className="eva-ab-tv-spacer" />
        {run.at === null ? null : (
          <span className="eva-ab-tv-dim" title={new Date(run.at).toLocaleString()}>
            {agoLabel(run.at, now)}
          </span>
        )}
        {onCollapse ? (
          <Tooltip label="Collapse panel" openDelay={300}>
            <UnstyledButton
              className="eva-ab-tv-iconbtn"
              aria-label="Collapse panel"
              data-testid="agents-panel-collapse"
              onClick={onCollapse}
            >
              <IconLayoutSidebarRightCollapse size={15} stroke={1.5} />
            </UnstyledButton>
          </Tooltip>
        ) : null}
        {onClose ? (
          <Tooltip label="Close" openDelay={300}>
            <UnstyledButton
              className="eva-ab-tv-iconbtn"
              aria-label="Close panel"
              data-testid="agents-panel-close"
              onClick={onClose}
            >
              <IconX size={15} stroke={1.5} />
            </UnstyledButton>
          </Tooltip>
        ) : null}
      </header>
      <div className="eva-ab-tv-scroll eva-sp-panel-body">
        {shown ? (
          <RunDetails run={shown} />
        ) : failed ? (
          <div className="eva-agents-error" role="alert" data-testid="specialists-panel-error">
            {failed}
          </div>
        ) : (
          <div className="eva-ab-tv-dim">Reading the reply</div>
        )}
      </div>
    </div>
  )
}
