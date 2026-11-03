import { useEffect } from 'react'
import { ActionIcon, Button, Switch, Tooltip, VisuallyHidden } from '@mantine/core'
import {
  IconAlertTriangle,
  IconCheck,
  IconLoader2,
  IconMessageCircle,
  IconMinus,
  IconPlus,
  IconRefresh,
  IconTerminal2,
  IconTool,
  type Icon,
} from '@tabler/icons-react'
import type { Place } from '@evaos/shell-core'
import type { JobSummaryDto } from '@evaos/contract'
import { agoLabel, scheduleLabel } from '@evaos/eva-core/model/jobs'
import { registerReloader } from '../reload/reload'
import {
  ListEmpty,
  ListRow,
  ListStatus,
  ListView,
  rowTip,
  type ListColumn,
  type ListTone,
} from '../ui/list'
import { JobForm } from './JobForm'
import { formatNextDue } from './job-format'
import { loadJobs, openJobForm, setJobEnabled, useJobs } from './jobs-store'
import './jobs.css'

export const JOBS_ERROR_COPY =
  'Could not read the jobs folder. Check that jobs/ exists in the Eva repo, then press the refresh shortcut.'

interface Badge {
  Glyph: Icon
  text: string
  tone: 'success' | 'warning' | 'dim'
  spin?: boolean
}

const PILL_TONE: Record<Badge['tone'], ListTone> = { success: 'ok', warning: 'bad', dim: 'dim' }

const COLUMNS: ListColumn[] = [
  { id: 'name', label: 'Name', width: 'minmax(0, 2.2fr)' },
  { id: 'last', label: 'Last run', width: 'minmax(120px, 1fr)' },
  { id: 'enabled', label: 'Enabled', width: '64px' },
]

/**
 * How the last run ended; null when the job ran but left no run record (script jobs only stamp
 * last-run), so the row shows just when, like native jobs_view.rs last_run_label.
 */
export function runBadge(job: JobSummaryDto): Badge | null {
  switch (job.runState) {
    case 'ok':
      return { Glyph: IconCheck, text: 'ok', tone: 'success' }
    case 'failed':
      return { Glyph: IconAlertTriangle, text: 'failed', tone: 'warning' }
    case 'running':
      return { Glyph: IconLoader2, text: 'running', tone: 'success', spin: true }
    case 'never':
      return job.lastRunAt === null ? { Glyph: IconMinus, text: 'never run', tone: 'dim' } : null
    default:
      return { Glyph: IconMinus, text: job.runStateRaw ?? 'unknown', tone: 'dim' }
  }
}

function JobRow({ job, now }: { job: JobSummaryDto; now: number }) {
  const badge = runBadge(job)
  const due = formatNextDue(job.nextDueAt, job.enabled, job.every, new Date(now))
  const schedule = scheduleLabel(job.every)
  const Kind = job.hasScript ? IconTerminal2 : IconMessageCircle
  return (
    <ListRow
      data-testid={`job-row-${job.name}`}
      leading={<Kind size={16} stroke={1.5} aria-hidden />}
      // The schedule and next due live in the hover text; the job's own description is not shown.
      tooltip={rowTip(job.name, `${schedule} · ${due.text}`)}
      title={
        <>
          <span className="eva-jobs-mono">{job.name}</span>
          <VisuallyHidden component="span">
            {schedule} <span data-testid={`job-due-${job.name}`}>{due.text}</span>
          </VisuallyHidden>
        </>
      }
      dim={!job.enabled}
      onActivate={() => openJobForm({ mode: 'edit', name: job.name })}
      cells={[
        <span key="last" className="eva-jobs-last">
          {job.lastRunAt !== null ? (
            <span className="eva-dim">{agoLabel(job.lastRunAt, now)}</span>
          ) : null}
          {badge ? (
            <ListStatus
              items={[{ label: badge.text, tone: PILL_TONE[badge.tone] }]}
              icon={
                <badge.Glyph
                  size={16}
                  stroke={1.5}
                  aria-hidden
                  className={badge.spin ? 'eva-list-spin' : undefined}
                />
              }
              data-testid={`job-state-${job.name}`}
            />
          ) : null}
        </span>,
        <span key="enabled" onClick={(e) => e.stopPropagation()}>
          <Tooltip label={job.enabled ? 'Enabled' : 'Disabled'} openDelay={300}>
            <Switch
              size="md"
              data-testid={`job-enabled-${job.name}`}
              aria-label={`Enable ${job.name}`}
              checked={job.enabled}
              onChange={(e) => void setJobEnabled(job.name, e.currentTarget.checked)}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </Tooltip>
        </span>,
      ]}
    />
  )
}

export function JobsPage(_props: { place: Place }) {
  const list = useJobs((s) => s.list)
  const now = useJobs((s) => s.now)
  const loading = useJobs((s) => s.loading)
  const error = useJobs((s) => s.error)

  useEffect(() => {
    const off = registerReloader('jobs', loadJobs, ['jobs'])
    void loadJobs()
    return off
  }, [])

  const scheduled = list?.filter((j) => j.scheduled).length ?? 0
  const newJob = (
    <Button
      leftSection={<IconPlus size={16} />}
      data-testid="jobs-new"
      onClick={() => openJobForm({ mode: 'create' })}
    >
      New job
    </Button>
  )

  return (
    <div className="eva-jobs-col" data-testid="page-jobs">
      <div className="eva-jobs-head">
        <h1 className="eva-jobs-title">Jobs</h1>
        {list ? (
          <span className="eva-jobs-badge" data-testid="jobs-scheduled">
            {scheduled} scheduled
          </span>
        ) : null}
        <span className="eva-jobs-spacer" />
        <Tooltip label="Refresh" openDelay={300}>
          <ActionIcon
            variant="default"
            aria-label="Refresh jobs"
            data-testid="jobs-refresh"
            onClick={() => void loadJobs()}
          >
            <IconRefresh size={16} />
          </ActionIcon>
        </Tooltip>
        {list && list.length > 0 ? newJob : null}
      </div>
      <ListView<JobSummaryDto>
        data-testid="jobs-table"
        columns={COLUMNS}
        groups={[{ id: 'jobs', items: list ?? [] }]}
        rowKey={(j) => j.name}
        renderRow={(j) => <JobRow key={j.name} job={j} now={now} />}
        error={
          list === null && error ? (
            <ListEmpty
              role="alert"
              data-testid="jobs-error"
              action={
                <Button variant="default" onClick={() => void loadJobs()} data-testid="jobs-retry">
                  Retry
                </Button>
              }
            >
              {JOBS_ERROR_COPY}
            </ListEmpty>
          ) : undefined
        }
        loading={
          list === null || (loading && list.length === 0)
            ? { label: 'Loading jobs', testid: 'jobs-loading' }
            : false
        }
        empty={
          <ListEmpty
            data-testid="jobs-empty"
            icon={<IconTool size={24} stroke={1.5} />}
            title="No jobs yet"
            action={newJob}
          >
            Create a job to have Eva run steps on a schedule.
          </ListEmpty>
        }
      />
      <JobForm />
    </div>
  )
}
