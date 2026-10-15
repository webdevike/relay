import './strips.css'
import { useEffect, useState } from 'react'
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react'
import type { BgJob } from '@evaos/chat-core/message'

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function jobsText(n: number): string {
  return n === 1 ? '1 background job running' : `${n} background jobs running`
}

/** Above the composer while this app's omp runs and a background job is unfinished. */
export function JobsStrip({
  running,
  jobs,
  now = Date.now,
}: {
  running: boolean
  jobs: readonly BgJob[]
  now?: () => number
}) {
  const [open, setOpen] = useState(false)
  const [, tick] = useState(0)
  const visible = running && jobs.length > 0
  useEffect(() => {
    if (!visible || !open) return
    const h = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(h)
  }, [visible, open])
  if (!visible) return null
  return (
    <div className="eva-jobs" data-testid="jobs-strip">
      <button
        type="button"
        className="eva-jobs-head eva-label"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? (
          <IconChevronDown size={12} aria-hidden="true" />
        ) : (
          <IconChevronRight size={12} aria-hidden="true" />
        )}
        <span>{jobsText(jobs.length)}</span>
      </button>
      {open ? (
        <div className="eva-jobs-rows">
          {jobs.map((j) => (
            <div className="eva-jobs-row eva-label" key={j.id} data-testid="jobs-row">
              <span className="eva-jobs-label eva-mono" title={j.label}>
                {j.label}
              </span>
              <span className="eva-jobs-elapsed eva-dim" data-testid="jobs-elapsed">
                {j.startedAt > 0 ? elapsed(now() - j.startedAt) : ''}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
