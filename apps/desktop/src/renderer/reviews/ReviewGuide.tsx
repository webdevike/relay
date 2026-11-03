import { useEffect, useMemo, useRef, useState } from 'react'
import { Checkbox, Loader } from '@mantine/core'
import { IconCheck, IconDots, IconFile } from '@tabler/icons-react'
import type { ReviewGuide as Guide, ReviewPr } from '@evaos/contract'
import { invoke } from '../ipc'
import { openLink } from '../navigation/open-link'
import { EvaMenu } from '../overlay'
import { Markdown } from '../chat/markdown/Markdown'
import { DiffView } from './DiffView'
import { parseDiff, splitPath } from './diff'

const two = (n: number): string => String(n).padStart(2, '0')

function FileMenu({ onViewInDiff, url }: { onViewInDiff: () => void; url: string }) {
  const [open, setOpen] = useState(false)
  return (
    <EvaMenu opened={open} onChange={setOpen} position="bottom-end" width={180}>
      <EvaMenu.Target>
        <button type="button" className="eva-rv-iconbtn" aria-label="File actions">
          <IconDots size={14} />
        </button>
      </EvaMenu.Target>
      <EvaMenu.Dropdown>
        <EvaMenu.Item onClick={onViewInDiff}>View in diff</EvaMenu.Item>
        <EvaMenu.Item onClick={() => openLink(url, { reviews: false })}>
          Open on GitHub
        </EvaMenu.Item>
      </EvaMenu.Dropdown>
    </EvaMenu>
  )
}

/**
 * The PR as a walkthrough in one scroll, like Linear's Guide: main writes 3 to 6 sections (a model
 * reads the title, description and diff; cached per head commit; grouped by folder when that
 * fails). Each section pairs its title, what and why, and file list on the left with its file cards
 * on the right. A reviewed file collapses; a thin tick rail on the far left tracks progress.
 * Reviewed is the same per-file state as Files' Viewed.
 */
export function ReviewGuide({
  pr,
  viewed,
  onViewed,
  onViewInDiff,
}: {
  pr: ReviewPr
  viewed: ReadonlySet<string>
  onViewed: (path: string, on: boolean) => void
  onViewInDiff: (path: string) => void
}) {
  const [guide, setGuide] = useState<Guide | string | null>(null)
  const refs = useRef<Array<HTMLElement | null>>([])
  const diffs = useMemo(() => new Map(parseDiff(pr.diff).map((f) => [f.path, f])), [pr.diff])
  const stats = useMemo(() => new Map(pr.files.map((f) => [f.path, f])), [pr.files])

  useEffect(() => {
    let live = true
    setGuide(null)
    void invoke('reviews.guide', { repo: pr.repo, number: pr.number }).then((r) => {
      if (live) setGuide(r.ok ? r.value : r.error.message)
    })
    return () => {
      live = false
    }
  }, [pr.repo, pr.number, pr.updatedAt])

  const head = (
    <header className="eva-rv-lguide-head">
      <h1 className="eva-rv-lguide-title">{pr.title}</h1>
      <div className="eva-rv-meta">
        <span>{pr.author.login}</span>·
        <span className="eva-rv-mono">
          {pr.repo.split('/')[1]}#{pr.number}
        </span>
        ·<span className="eva-rv-mono">{pr.base}</span>
        <span className="eva-rv-dim">‹</span>
        <span className="eva-rv-mono">{pr.head}</span>
      </div>
    </header>
  )

  if (guide === null || typeof guide === 'string') {
    return (
      <div className="eva-rv-lguide" data-testid="review-guide">
        <nav className="eva-rv-ticks" aria-hidden />
        <div className="eva-rv-lguide-col">
          {head}
          {guide === null ? (
            <div className="eva-rv-lguide-wait" data-testid="review-guide-loading">
              <Loader size={14} />
              Writing the walkthrough from the description and diff...
            </div>
          ) : (
            <div className="eva-rv-error">Couldn't build the guide: {guide}</div>
          )}
        </div>
      </div>
    )
  }

  const sections = guide.sections
  return (
    <div className="eva-rv-lguide" data-testid="review-guide" data-source={guide.source}>
      <nav className="eva-rv-ticks" aria-label="Sections">
        {sections.map((s, i) => (
          <button
            key={i}
            type="button"
            className="eva-rv-tick"
            data-done={s.files.every((f) => viewed.has(f)) || undefined}
            title={`${two(i + 1)} ${s.title}`}
            aria-label={`Section ${i + 1}: ${s.title}`}
            onClick={() => refs.current[i]?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
          />
        ))}
      </nav>
      <div className="eva-rv-lguide-col">
        {head}
        {guide.source === 'folders' ? (
          <div className="eva-rv-dim eva-rv-small" data-testid="review-guide-fallback">
            Grouped by folder: the walkthrough couldn't be written ({guide.error}).
          </div>
        ) : null}
        {sections.map((s, i) => (
          <section
            key={i}
            className="eva-rv-lsec"
            ref={(el) => {
              refs.current[i] = el
            }}
            data-testid="review-guide-section"
          >
            <div className="eva-rv-lsec-left">
              <div className="eva-rv-dim eva-rv-small">
                {two(i + 1)} / {two(sections.length)}
              </div>
              <h2 className="eva-rv-lsec-title">{s.title}</h2>
              {s.why ? (
                <div className="eva-rv-lsec-why">
                  <Markdown text={s.why} />
                </div>
              ) : null}
              <div className="eva-rv-lsec-files">
                {s.files.map((path) => {
                  const { dir, name } = splitPath(path)
                  const f = stats.get(path)
                  return (
                    <button
                      key={path}
                      type="button"
                      className="eva-rv-lsec-file"
                      onClick={() =>
                        refs.current[i]
                          ?.querySelector(`[data-gfile="${CSS.escape(path)}"]`)
                          ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                      }
                    >
                      <IconFile size={13} className="eva-rv-dim" />
                      <span className="eva-rv-ellipsis">
                        {name} <span className="eva-rv-dim">{dir.replace(/\/$/, '')}</span>
                      </span>
                      <span className="eva-rv-spacer" />
                      {f?.additions ? <span className="eva-rv-add">+{f.additions}</span> : null}
                      {f?.deletions ? <span className="eva-rv-del">-{f.deletions}</span> : null}
                      {viewed.has(path) ? <IconCheck size={13} className="eva-rv-accent" /> : null}
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="eva-rv-lsec-right">
              {s.files.map((path) => {
                const { dir, name } = splitPath(path)
                const f = stats.get(path)
                const d = diffs.get(path)
                const reviewed = viewed.has(path)
                return (
                  <div key={path} className="eva-rv-gcard" data-gfile={path}>
                    <div className="eva-rv-gcard-head">
                      <IconFile size={14} className="eva-rv-dim" />
                      <span className="eva-rv-ellipsis">
                        {name} <span className="eva-rv-dim">{dir}</span>
                      </span>
                      <span className="eva-rv-spacer" />
                      {f?.additions ? <span className="eva-rv-add">+{f.additions}</span> : null}
                      {f?.deletions ? <span className="eva-rv-del">-{f.deletions}</span> : null}
                      <Checkbox
                        size="xs"
                        label="Reviewed"
                        checked={reviewed}
                        onChange={(e) => onViewed(path, e.currentTarget.checked)}
                      />
                      <FileMenu url={`${pr.url}/files`} onViewInDiff={() => onViewInDiff(path)} />
                    </div>
                    {reviewed ? null : d && d.hunks.length > 0 ? (
                      <DiffView hunks={d.hunks} mode="unified" path={path} />
                    ) : (
                      <div className="eva-rv-empty">
                        {d?.binary ? 'Binary file' : 'No text changes to show'}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
