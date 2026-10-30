import { useEffect, useState } from 'react'
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import type { ReviewCommit, ReviewPr } from '@evaos/contract'
import { invoke } from '../ipc'
import { Markdown } from '../chat/markdown/Markdown'
import { DiffView } from './DiffView'
import { parseHunks, splitPath } from './diff'
import { commitWhy } from './review-model'

const two = (n: number): string => String(n).padStart(2, '0')

/**
 * The PR as a story, one step at a time: each commit in order, its message as the why, then the
 * code it changed. Commits load on demand (one `gh api` call per step shown).
 */
export function ReviewGuide({ pr, onViewInDiff }: { pr: ReviewPr; onViewInDiff: (path: string) => void }) {
  const steps = pr.commits
  const [step, setStep] = useState(0)
  const [loaded, setLoaded] = useState<Record<string, ReviewCommit | string>>({})
  const commit = steps[step]

  useEffect(() => {
    if (!commit || loaded[commit.oid] !== undefined) return
    let live = true
    void invoke('reviews.commit', { repo: pr.repo, oid: commit.oid }).then((r) => {
      if (live) setLoaded((m) => ({ ...m, [commit.oid]: r.ok ? r.value : r.error.message }))
    })
    return () => {
      live = false
    }
  }, [commit, loaded, pr.repo])

  if (!commit) return <div className="eva-rv-empty">This pull request has no commits.</div>
  const data = loaded[commit.oid]
  const prev = steps[step - 1]
  const next = steps[step + 1]
  // Only files that are still in the PR: a later commit may have dropped a file again.
  const inPr = new Set(pr.files.map((f) => f.path))

  return (
    <div className="eva-rv-guide" data-testid="review-guide">
      <div className="eva-rv-guide-top">
        <span className="eva-rv-guide-count">
          <b>{two(step + 1)}</b> / {two(steps.length)}
        </span>
        <span className="eva-rv-dim eva-rv-ellipsis">{commit.headline}</span>
        <span className="eva-rv-spacer" />
        <button type="button" className="eva-rv-iconbtn" aria-label="Previous step" disabled={!prev} onClick={() => setStep(step - 1)}>
          <IconChevronLeft size={15} />
        </button>
        <button type="button" className="eva-rv-iconbtn" aria-label="Next step" disabled={!next} onClick={() => setStep(step + 1)}>
          <IconChevronRight size={15} />
        </button>
      </div>
      <div className="eva-rv-stepper">
        {steps.map((c, i) => (
          <button
            key={c.oid}
            type="button"
            className="eva-rv-stepbar"
            data-state={i < step ? 'done' : i === step ? 'current' : 'todo'}
            aria-label={`Step ${i + 1}: ${c.headline}`}
            title={c.headline}
            onClick={() => setStep(i)}
          />
        ))}
      </div>
      <h2 className="eva-rv-guide-title">{commit.headline}</h2>
      {data === undefined ? (
        <div className="eva-rv-dim">Loading this step...</div>
      ) : typeof data === 'string' ? (
        <div className="eva-rv-error">Couldn't load this commit: {data}</div>
      ) : (
        <>
          {commitWhy(data.message) ? (
            <div className="eva-rv-guide-why">
              <Markdown text={commitWhy(data.message)} />
            </div>
          ) : null}
          {data.files.map((f) => {
            const { dir, name } = splitPath(f.path)
            const hunks = parseHunks(f.patch)
            return (
              <div key={f.path} className="eva-rv-guide-file">
                <div className="eva-rv-guide-filehead">
                  <span className="eva-rv-path">
                    <span className="eva-rv-dim">{dir}</span>
                    {name}
                  </span>
                  {f.status !== 'modified' ? (
                    <span className="eva-rv-pill" data-tone="green">{f.status}</span>
                  ) : null}
                  <span className="eva-rv-add">+{f.additions}</span>
                  <span className="eva-rv-del">-{f.deletions}</span>
                  {inPr.has(f.path) ? (
                    <button type="button" className="eva-rv-link" onClick={() => onViewInDiff(f.path)}>
                      View in diff
                    </button>
                  ) : null}
                </div>
                {hunks.length > 0 ? (
                  <div className="eva-rv-guide-code">
                    <DiffView hunks={hunks} mode="unified" />
                  </div>
                ) : (
                  <div className="eva-rv-empty">No text changes to show</div>
                )}
              </div>
            )
          })}
        </>
      )}
      <div className="eva-rv-guide-nav">
        {prev ? (
          <button type="button" className="eva-rv-guide-navbtn" onClick={() => setStep(step - 1)}>
            <IconChevronLeft size={14} />
            <span className="eva-rv-dim">{two(step)}</span> {prev.headline}
          </button>
        ) : (
          <span />
        )}
        {next ? (
          <button type="button" className="eva-rv-guide-navbtn" data-next onClick={() => setStep(step + 1)}>
            <span className="eva-rv-dim">{two(step + 2)}</span> {next.headline}
            <IconChevronRight size={14} />
          </button>
        ) : null}
      </div>
    </div>
  )
}
