import { ActionIcon, Button, Progress, Tooltip } from '@mantine/core'
import { IconMovie, IconPhoto, IconPlayerStop, IconTrash, IconWand } from '@tabler/icons-react'
import { studioEtaLabel, type StudioBackend, type StudioJob } from '@evaos/contract'
import { mediaUrl } from '../chat/widgets/media-url'

const STATE_LABEL: Record<StudioJob['state'], string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export interface StudioQueueProps {
  /** Queued, running and failed jobs, newest first. */
  jobs: readonly StudioJob[]
  backends: readonly StudioBackend[]
  onCancel: (job: StudioJob) => void
  onRemix: (job: StudioJob) => void
  onDismiss: (job: StudioJob) => void
}

/** Jobs on their way (and ones that failed), as flat rows under hairlines. */
export function StudioQueue({ jobs, backends, onCancel, onRemix, onDismiss }: StudioQueueProps) {
  if (jobs.length === 0) return null
  const label = new Map(backends.map((b) => [b.id, b.label]))
  return (
    <div className="eva-studio-queue" data-testid="studio-queue">
      {jobs.map((job) => {
        const thumb = job.outputs[0]?.thumb
        const Mode = job.spec.mode === 'video' ? IconMovie : IconPhoto
        const eta = job.state === 'failed' ? undefined : studioEtaLabel(job.etaMs)
        return (
          <div
            key={job.id}
            className="eva-studio-row"
            data-testid="studio-queue-row"
            data-state={job.state}
          >
            <div className="eva-studio-row-thumb">
              {thumb ? <img src={mediaUrl(thumb)} alt="" /> : <Mode size={18} stroke={1.5} />}
            </div>
            <div className="eva-studio-row-body">
              <div className="eva-studio-row-top">
                <span className="eva-studio-row-prompt" title={job.spec.prompt}>
                  {job.spec.prompt}
                </span>
                <span className="eva-studio-pill" data-state={job.state}>
                  {STATE_LABEL[job.state]}
                </span>
              </div>
              <div className="eva-studio-row-meta">
                <span>{label.get(job.spec.backend) ?? job.spec.backend}</span>
                {job.state === 'failed' ? null : job.note ? <span>{job.note}</span> : null}
                {eta ? <span>{eta}</span> : null}
              </div>
              {job.state === 'failed' ? (
                <div className="eva-studio-row-error">
                  <span>{job.error ?? 'This job failed.'}</span>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    leftSection={<IconWand size={12} stroke={1.5} />}
                    onClick={() => onRemix(job)}
                  >
                    Remix
                  </Button>
                </div>
              ) : (
                <Progress
                  size="xs"
                  value={Math.round(job.progress * 100)}
                  animated={job.state === 'running'}
                  aria-label="Progress"
                />
              )}
            </div>
            {job.state === 'failed' ? (
              <Tooltip label="Dismiss" openDelay={400}>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label="Dismiss"
                  onClick={() => onDismiss(job)}
                >
                  <IconTrash size={16} stroke={1.5} />
                </ActionIcon>
              </Tooltip>
            ) : (
              <Tooltip label="Cancel" openDelay={400}>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label="Cancel"
                  data-testid="studio-cancel"
                  onClick={() => onCancel(job)}
                >
                  <IconPlayerStop size={16} stroke={1.5} />
                </ActionIcon>
              </Tooltip>
            )}
          </div>
        )
      })}
    </div>
  )
}
