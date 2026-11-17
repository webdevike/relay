import { useEffect, useState, type ReactNode } from 'react'
import { Avatar, Tooltip, UnstyledButton } from '@mantine/core'
import {
  IconAlertCircle,
  IconCalendarRepeat,
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
import { TrialCard } from '../chat/trials/TrialCard'
import { useTrials } from '../chat/trials/trials-store'
import { costLabel, RunDetails } from '../chat/RunDetails'
import { useAssistants } from '../assistants/assistants-store'
import { portrait } from '../ui/portrait'
import {
  ListEmpty,
  ListRow,
  ListStatus,
  ListTime,
  ListView,
  rowTip,
  type ListTone,
} from '../ui/list'
import type { PanelChrome } from '../agents-board/AgentPanel'
import { selectRun, useSpecialists } from './specialists-store'
import { callerAssistant, callerName, runOrigin } from './specialists-view'

const ICON = { size: 16, stroke: 1.5, 'aria-hidden': true } as const
const STATUS: Record<SpecialistRun['status'], { label: string; tone: ListTone; icon: ReactNode }> =
  {
    running: { label: 'Running', tone: 'info', icon: <IconLoader2 {...ICON} /> },
    done: { label: 'Done', tone: 'ok', icon: <IconCircleCheck {...ICON} /> },
    failed: { label: 'Failed', tone: 'bad', icon: <IconAlertCircle {...ICON} /> },
  }
/** A stable empty list, so the assistants selector does not re-render while they load. */
const NO_ASSISTANTS: readonly Assistant[] = []

/**
 * Who started a run, as a round face: the assistant's portrait, a chat bubble, a calendar for a
 * run nobody asked for (a schedule, an event), or a question mark when an ask did not say.
 */
function CallerAvatar({
  run,
  size,
}: {
  run: Pick<SpecialistRun, 'caller' | 'job'>
  size: 'sm' | 'md'
}) {
  const caller: SpecialistCaller = run.caller
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
      {caller.kind === 'chat' ? (
        <IconMessage {...glyph} />
      ) : caller.kind === 'none' && run.job !== null ? (
        <IconCalendarRepeat {...glyph} />
      ) : (
        <IconUserQuestion {...glyph} />
      )}
    </Avatar>
  )
}

/**
 * One agent's newest runs, asked for or not, as flat rows: who started it, the request on one
 * line, cost, status and age. A row opens its output in the side panel.
 */
export function AgentRuns({ agent, now }: { agent: string; now: number }) {
  const data = useSpecialists((s) => s.runs[agent] ?? null)
  const error = useSpecialists((s) => s.runsError)
  const selected = useSpecialists((s) => s.run)
  const assistants = useAssistants((s) => s.data?.agents ?? NO_ASSISTANTS)

  if (data === null && error !== null)
    return (
      <ListEmpty role="alert" data-testid="agent-runs-error" title="Could not read the runs">
        {error}
      </ListEmpty>
    )
  return (
    <div className="eva-sp-runs">
      {data?.error ? (
        <ListEmpty role="alert" data-testid="agent-runs-error" title="Could not read the runs">
          {data.error}
        </ListEmpty>
      ) : null}
      <ListView
        data-testid="agent-runs"
        groups={[{ id: 'runs', items: data?.runs ?? [] }]}
        rowKey={(r) => r.run}
        loading={data === null ? { label: 'Loading runs' } : false}
        renderRow={(r) => {
          const status = STATUS[r.status]
          const origin =
            r.trial === undefined
              ? runOrigin(r, assistants)
              : `${runOrigin(r, assistants)} · Trial ${r.trial}`
          return (
            <ListRow
              key={r.run}
              data-testid={`agent-run-${r.run}`}
              data-status={r.status}
              active={r.run === selected}
              tile={false}
              leading={<CallerAvatar run={r} size="md" />}
              title={r.summary ?? (r.job === null ? agentLabel(r.agent) : `${r.job} run`)}
              meta={origin}
              tooltip={rowTip(
                r.summary,
                origin,
                r.model,
                r.error,
                r.at === null ? null : new Date(r.at).toLocaleString(),
              )}
              trailing={
                <>
                  <span className="eva-sp-num eva-sp-cost">
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
            data-testid="agent-runs-empty"
            icon={<IconRosette size={24} stroke={1.5} />}
            title="No runs yet"
          >
            Each run shows up here, asked for by an assistant or started by a schedule or event.
          </ListEmpty>
        }
      />
    </div>
  )
}

/**
 * The side panel for one run: who started it and when, then its request and output as the service
 * has it now. A trial's run shows the trial's blind A / B / C card instead (models hidden until
 * Isaac picks), as the host has it.
 */
export function SpecialistRunView({
  run,
  now,
  onClose,
  onCollapse,
}: { run: SpecialistRun; now: number } & PanelChrome) {
  const assistants = useAssistants((s) => s.data?.agents ?? NO_ASSISTANTS)
  const card = useTrials((s) => s.trials.find((t) => t.id === run.trialId) ?? null)
  const [shown, setShown] = useState<AgentRun | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const trial = run.trial !== undefined
  useEffect(() => {
    // A trial arm answers no request, and the caller's own arm would name its model before a pick.
    if (trial) return
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
  }, [run.run, run.agent, run.status, trial])

  return (
    <div className="eva-ab-tv" data-testid="specialists-panel">
      <header className="eva-ab-tv-head">
        <CallerAvatar run={run} size="sm" />
        <span className="eva-sp-panel-who">{runOrigin(run, assistants)}</span>
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
        {trial ? (
          card ? (
            <TrialCard trial={card} />
          ) : (
            <div className="eva-ab-tv-dim" data-testid="specialists-panel-trial">
              {`Arm ${String(run.trial)} of a blind trial. Its result is on the trial card in the chat that asked${run.model === null ? ', and its model shows once you pick' : ''}.`}
            </div>
          )
        ) : shown ? (
          <RunDetails run={shown} />
        ) : failed ? (
          <div className="eva-agents-error" role="alert" data-testid="specialists-panel-error">
            {failed}
          </div>
        ) : (
          <div className="eva-ab-tv-dim">Reading the output</div>
        )}
      </div>
    </div>
  )
}
