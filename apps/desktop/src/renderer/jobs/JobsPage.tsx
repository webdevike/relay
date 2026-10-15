import { useEffect } from 'react'
import { ActionIcon, Button, Switch, Tooltip } from '@mantine/core'
import {
  IconAlertTriangle,
  IconCheck,
  IconLoader2,
  IconMinus,
  IconPlus,
  IconRefresh,
  IconTool,
  type Icon,
} from '@tabler/icons-react'
import type { Place } from '@evaos/shell-core'
import type { JobSummaryDto } from '@evaos/contract'
import { agoLabel, scheduleLabel } from '@evaos/eva-core/model/jobs'
import { registerReloader } from '../reload/reload'
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

export function runBadge(job: JobSummaryDto): Badge {
  switch (job.runState) {
    case 'ok':
      return { Glyph: IconCheck, text: 'ok', tone: 'success' }
    case 'failed':
      return { Glyph: IconAlertTriangle, text: 'failed', tone: 'warning' }
    case 'running':
      return { Glyph: IconLoader2, text: 'running', tone: 'success', spin: true }
    case 'never':
      return { Glyph: IconMinus, text: 'never run', tone: 'dim' }
    default:
      return { Glyph: IconMinus, text: job.runStateRaw ?? 'unknown', tone: 'dim' }
  }
}

function Row({ job, now }: { job: JobSummaryDto; now: number }) {
  const badge = runBadge(job)
  const due = formatNextDue(job.nextDueAt, job.enabled, job.every, new Date(now))
  return (
    <div
      role="button"
      tabIndex={0}
      className="eva-jobs-grid eva-jobs-row"
      data-testid={`job-row-${job.name}`}
      onClick={() => openJobForm({ mode: 'edit', name: job.name })}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          openJobForm({ mode: 'edit', name: job.name })
        }
      }}
    >
      <span className="eva-jobs-name">
        <span className="eva-jobs-mono">{job.name}</span>
        {job.description ? <span className="eva-jobs-desc">{job.description}</span> : null}
      </span>
      <span>{scheduleLabel(job.every)}</span>
      <span className="eva-jobs-last">
        {job.lastRunAt !== null ? (
          <span className="eva-jobs-dim">{agoLabel(job.lastRunAt, now)}</span>
        ) : null}
        <span
          className="eva-jobs-state"
          data-tone={badge.tone}
          data-testid={`job-state-${job.name}`}
        >
          <badge.Glyph size={14} className={badge.spin ? 'eva-jobs-spin' : undefined} />
          {badge.text}
        </span>
      </span>
      <span
        className={due.tone === 'normal' ? undefined : `eva-jobs-${due.tone}`}
        data-testid={`job-due-${job.name}`}
      >
        {due.text}
      </span>
      <span className="eva-jobs-switch-cell" onClick={(e) => e.stopPropagation()}>
        <Tooltip label={job.enabled ? 'Enabled' : 'Disabled'} openDelay={300}>
          <Switch
            className="eva-switch"
            size="md"
            data-testid={`job-enabled-${job.name}`}
            aria-label={`Enable ${job.name}`}
            checked={job.enabled}
            onChange={(e) => void setJobEnabled(job.name, e.currentTarget.checked)}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </Tooltip>
      </span>
    </div>
  )
}

export function JobsPage(_props: { place: Place }) {
  const list = useJobs((s) => s.list)
  const now = useJobs((s) => s.now)
  const loading = useJobs((s) => s.loading)
  const error = useJobs((s) => s.error)

  useEffect(() => {
    const off = registerReloader('jobs', loadJobs)
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

  let body
  if (list === null && error) {
    body = (
      <div className="eva-jobs-empty" role="alert" data-testid="jobs-error">
        <p>{JOBS_ERROR_COPY}</p>
        <Button variant="default" onClick={() => void loadJobs()} data-testid="jobs-retry">
          Retry
        </Button>
      </div>
    )
  } else if (list === null || (loading && list.length === 0)) {
    body = (
      <p className="eva-jobs-dim" data-testid="jobs-loading">
        Loading jobs
      </p>
    )
  } else if (list.length === 0) {
    body = (
      <div className="eva-jobs-empty" data-testid="jobs-empty">
        <IconTool size={24} />
        <h2>No jobs yet</h2>
        <p className="eva-jobs-dim">Create a job to have Eva run steps on a schedule.</p>
        {newJob}
      </div>
    )
  } else {
    body = (
      <div className="eva-jobs-card" data-testid="jobs-table">
        <div className="eva-jobs-grid eva-jobs-header" role="presentation">
          <span>Name</span>
          <span>Schedule</span>
          <span>Last run</span>
          <span>Next due</span>
          <span>Enabled</span>
        </div>
        {list.map((job) => (
          <Row key={job.name} job={job} now={now} />
        ))}
      </div>
    )
  }

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
      {body}
      <JobForm />
    </div>
  )
}
