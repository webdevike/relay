import { useEffect, useRef, useState } from 'react'
import { Checkbox } from '@mantine/core'
import { IconCheck, IconDots, IconFile } from '@tabler/icons-react'
import type { ReviewCommit, ReviewPr } from '@evaos/contract'
import { invoke } from '../ipc'
import { openLink } from '../navigation/open-link'
import { EvaMenu } from '../overlay'
import { Markdown } from '../chat/markdown/Markdown'
import { DiffView } from './DiffView'
import { parseHunks, splitPath } from './diff'
import { commitWhy } from './review-model'

const two = (n: number): string => String(n).padStart(2, '0')

/** Core change first: source, then tests, then docs, config and lockfiles. */
function fileRank(path: string): number {
  if (
    /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|^\.changeset\/|\.(md|json|ya?ml|toml)$/i.test(
      path,
    )
  )
    return 2
  if (/(\.test|\.spec)\.\w+$|(^|\/)(__tests__|tests?)\//.test(path)) return 1
  return 0
}

type Loaded = ReviewCommit | string

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
        <EvaMenu.Item onClick={() => openLink(url)}>Open on GitHub</EvaMenu.Item>
      </EvaMenu.Dropdown>
    </EvaMenu>
  )
}

/**
 * The PR as a story in one scroll, like Linear's Guide: each section (a commit, merges left out)
 * pairs its what and why (the commit message body) and file list on the left with that section's
 * file cards on the right. A reviewed file collapses; a thin tick rail on the far left tracks
 * progress. Reviewed is the same per-file state as Files' Viewed.
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
  const sections = pr.commits.filter((c) => !/^Merge (remote-tracking )?branch /.test(c.headline))
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({})
  const refs = useRef<Array<HTMLElement | null>>([])

  useEffect(() => {
    let live = true
    for (const c of sections) {
      void invoke('reviews.commit', { repo: pr.repo, oid: c.oid }).then((r) => {
        if (live) setLoaded((m) => ({ ...m, [c.oid]: r.ok ? r.value : r.error.message }))
      })
    }
    return () => {
      live = false
    }
    // Sections derive from pr.commits; refetch only for another PR.
  }, [pr.url])

  // Only files still in the PR count toward review (a later commit may drop one again).
  const inPr = new Set(pr.files.map((f) => f.path))
  const filesOf = (oid: string): ReviewCommit['files'] => {
    const d = loaded[oid]
    if (d === undefined || typeof d === 'string') return []
    return [...d.files].sort((a, b) => fileRank(a.path) - fileRank(b.path))
  }
  const sectionDone = (oid: string): boolean => {
    const files = filesOf(oid).filter((f) => inPr.has(f.path))
    return files.length > 0 && files.every((f) => viewed.has(f.path))
  }

  if (sections.length === 0) {
    return <div className="eva-rv-empty">This pull request has no commits.</div>
  }

  return (
    <div className="eva-rv-lguide" data-testid="review-guide">
      <nav className="eva-rv-ticks" aria-label="Sections">
        {sections.map((c, i) => (
          <button
            key={c.oid}
            type="button"
            className="eva-rv-tick"
            data-done={sectionDone(c.oid) || undefined}
            title={`${two(i + 1)} ${c.headline}`}
            aria-label={`Section ${i + 1}: ${c.headline}`}
            onClick={() => refs.current[i]?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
          />
        ))}
      </nav>
      <div className="eva-rv-lguide-col">
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
        {sections.map((c, i) => {
          const data = loaded[c.oid]
          const files = filesOf(c.oid)
          const title = typeof data === 'object' ? data.message.split('\n', 1)[0] : c.headline
          const why = typeof data === 'object' ? commitWhy(data.message) : ''
          return (
            <section
              key={c.oid}
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
                <h2 className="eva-rv-lsec-title">{title}</h2>
                {data === undefined ? <div className="eva-rv-dim">Loading...</div> : null}
                {typeof data === 'string' ? (
                  <div className="eva-rv-error">Couldn't load this commit: {data}</div>
                ) : null}
                {why ? (
                  <div className="eva-rv-lsec-why">
                    <Markdown text={why} />
                  </div>
                ) : null}
                {files.length > 0 ? (
                  <div className="eva-rv-lsec-files">
                    {files.map((f) => {
                      const { dir, name } = splitPath(f.path)
                      return (
                        <button
                          key={f.path}
                          type="button"
                          className="eva-rv-lsec-file"
                          onClick={() =>
                            refs.current[i]
                              ?.querySelector(`[data-gfile="${CSS.escape(f.path)}"]`)
                              ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                          }
                        >
                          <IconFile size={13} className="eva-rv-dim" />
                          <span className="eva-rv-ellipsis">
                            {name} <span className="eva-rv-dim">{dir.replace(/\/$/, '')}</span>
                          </span>
                          <span className="eva-rv-spacer" />
                          {f.additions ? <span className="eva-rv-add">+{f.additions}</span> : null}
                          {f.deletions ? <span className="eva-rv-del">-{f.deletions}</span> : null}
                          {viewed.has(f.path) ? (
                            <IconCheck size={13} className="eva-rv-accent" />
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                ) : null}
              </div>
              <div className="eva-rv-lsec-right">
                {files.map((f) => {
                  const { dir, name } = splitPath(f.path)
                  const reviewed = viewed.has(f.path)
                  const hunks = parseHunks(f.patch)
                  return (
                    <div key={f.path} className="eva-rv-gcard" data-gfile={f.path}>
                      <div className="eva-rv-gcard-head">
                        <IconFile size={14} className="eva-rv-dim" />
                        <span className="eva-rv-ellipsis">
                          {name} <span className="eva-rv-dim">{dir}</span>
                        </span>
                        <span className="eva-rv-spacer" />
                        {f.additions ? <span className="eva-rv-add">+{f.additions}</span> : null}
                        {f.deletions ? <span className="eva-rv-del">-{f.deletions}</span> : null}
                        <Checkbox
                          size="xs"
                          label="Reviewed"
                          checked={reviewed}
                          disabled={!inPr.has(f.path)}
                          onChange={(e) => onViewed(f.path, e.currentTarget.checked)}
                        />
                        <FileMenu
                          url={`${pr.url}/files`}
                          onViewInDiff={() => onViewInDiff(f.path)}
                        />
                      </div>
                      {reviewed ? null : hunks.length > 0 ? (
                        <DiffView hunks={hunks} mode="unified" />
                      ) : (
                        <div className="eva-rv-empty">No text changes to show</div>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
