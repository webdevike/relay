import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { Badge, Button, Checkbox, Loader } from '@mantine/core'
import { IconCheck, IconDots, IconFile } from '@tabler/icons-react'
import type { ReviewGuide as Guide, ReviewGuideHunk, ReviewPr } from '@evaos/contract'
import type { GuideCallout } from '@relay/protocol/review-guide'
import { invoke } from '../ipc'
import { openLink } from '../navigation/open-link'
import { EvaMenu } from '../overlay'
import { Markdown } from '../chat/markdown/Markdown'
import { parseOneOf, usePref } from '../ui-prefs'
import { DiffView } from './DiffView'
import { calloutsFor, sectionCode, type SectionFile } from './guide-hunks'
import { useLocal } from './review-ui'
import { parseDiff, splitPath, type DiffFile } from '@relay/protocol/unified-diff'

const two = (n: number): string => String(n).padStart(2, '0')
/** The runner's answer when the PR moved on under the request (the page reloads the PR once). */
const HEAD_CHANGED = 'PR changed; regenerating'
/** Shown when the PR moved again after that one reload. */
const STILL_CHANGING = 'The PR changed again while its walkthrough was loading.'
const RISK_COLOR = { low: 'green', medium: 'yellow', high: 'red' } as const
const parseDiffMode = parseOneOf<'split' | 'unified'>(['split', 'unified'])

type Section = Guide['sections'][number]

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

interface GuideProps {
  pr: ReviewPr
  viewed: ReadonlySet<string>
  onViewed: (path: string, on: boolean) => void
  onViewInDiff: (path: string) => void
  /** Reloads the PR (its new commits ask for the Guide again). */
  onStale?: (() => void) | undefined
}

/**
 * The Guide for the PR's base and head as shown. When the runner reads other commits (a push or a
 * base move landed after the PR loaded) the page reloads the PR once; if the reloaded PR moved
 * again the answer is an error with Reload, never an endless spinner.
 */
function useGuide(pr: ReviewPr, onStale: (() => void) | undefined) {
  const [guide, setGuide] = useState<Guide | string | null>(null)
  const reloadedFor = useRef<string | null>(null)
  const stale = useRef(onStale)
  useEffect(() => {
    stale.current = onStale
  })
  useEffect(() => {
    let live = true
    setGuide(null)
    const pin = { repo: pr.repo, number: pr.number, headSha: pr.headSha, baseSha: pr.baseSha }
    void invoke('reviews.guide', pin).then((r) => {
      if (!live) return
      if (r.ok) reloadedFor.current = null
      const moved = !r.ok && r.error.message === HEAD_CHANGED
      if (moved && reloadedFor.current !== pr.url && stale.current) {
        reloadedFor.current = pr.url
        setGuide(HEAD_CHANGED)
        stale.current()
        return
      }
      setGuide(r.ok ? r.value : moved ? STILL_CHANGING : r.error.message)
    })
    return () => {
      live = false
    }
    // A reloaded PR is a new object: it asks again even when its commits are the same.
  }, [pr])
  const reload = (): void => {
    reloadedFor.current = null
    setGuide(HEAD_CHANGED)
    stale.current?.()
  }
  return { guide, reload: onStale ? reload : null }
}

/**
 * The PR as a walkthrough in one scroll, like Linear's Guide. Main (or the host) has a model write
 * it from the title, description and annotated diff, cached per base and head commit. A v2 Guide
 * opens with an overview and risk, then 3 to 7 sections that each explain one concept, say what to
 * check and what could break, and show only the lines it cites with notes under them; files no
 * section shows are listed with View in diff, then follow-ups and a checklist. A v1 record (and
 * the folder fallback) shows each section's whole files, as before.
 */
export function ReviewGuide(props: GuideProps) {
  const { pr } = props
  const { guide, reload } = useGuide(pr, props.onStale)

  const head = <GuideHead pr={pr} />
  if (guide === null || typeof guide === 'string') {
    return (
      <div className="eva-rv-lguide" data-testid="review-guide">
        <nav className="eva-rv-ticks" aria-hidden />
        <div className="eva-rv-lguide-col">
          {head}
          <GuideWaiting error={guide} onReload={reload} />
        </div>
      </div>
    )
  }
  return guide.version === 2 ? (
    <GuideV2 {...props} guide={guide} head={head} />
  ) : (
    <GuideV1 {...props} guide={guide} head={head} />
  )
}

function GuideHead({ pr }: { pr: ReviewPr }) {
  return (
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
}

function GuideWaiting({
  error,
  onReload,
}: {
  error: string | null
  onReload: (() => void) | null
}) {
  if (error !== null && error !== HEAD_CHANGED) {
    return (
      <div className="eva-rv-error" data-testid="review-guide-error">
        Couldn't build the guide: {error}
        {error === STILL_CHANGING && onReload ? (
          <Button size="compact-xs" variant="subtle" onClick={onReload}>
            Reload the PR
          </Button>
        ) : null}
      </div>
    )
  }
  return (
    <div className="eva-rv-lguide-wait" data-testid="review-guide-loading">
      <Loader size={14} />
      {error === HEAD_CHANGED
        ? 'The PR changed; reloading it to write the walkthrough for the new commits...'
        : 'Writing the walkthrough from the description and diff...'}
      {error === HEAD_CHANGED && onReload ? (
        <Button size="compact-xs" variant="subtle" onClick={onReload}>
          Reload the PR
        </Button>
      ) : null}
    </div>
  )
}

function Ticks({
  sections,
  done,
  refs,
}: {
  sections: readonly Section[]
  done: (i: number) => boolean
  refs: MutableRefObject<Array<HTMLElement | null>>
}) {
  return (
    <nav className="eva-rv-ticks" aria-label="Sections">
      {sections.map((s, i) => (
        <button
          key={i}
          type="button"
          className="eva-rv-tick"
          data-done={done(i) || undefined}
          title={`${two(i + 1)} ${s.title}`}
          aria-label={`Section ${i + 1}: ${s.title}`}
          onClick={() => refs.current[i]?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
        />
      ))}
    </nav>
  )
}

function FileStats({ pr, path }: { pr: ReviewPr; path: string }) {
  const f = pr.files.find((x) => x.path === path)
  return (
    <>
      {f?.additions ? <span className="eva-rv-add">+{f.additions}</span> : null}
      {f?.deletions ? <span className="eva-rv-del">-{f.deletions}</span> : null}
    </>
  )
}

// ---- v1: each section's whole files (also the folder fallback) ----

function GuideV1({
  pr,
  guide,
  head,
  viewed,
  onViewed,
  onViewInDiff,
}: GuideProps & { guide: Guide; head: ReactNode }) {
  const refs = useRef<Array<HTMLElement | null>>([])
  const diffs = useMemo(() => new Map(parseDiff(pr.diff).map((f) => [f.path, f])), [pr.diff])
  const sections = guide.sections
  return (
    <div className="eva-rv-lguide" data-testid="review-guide" data-source={guide.source}>
      <Ticks
        sections={sections}
        refs={refs}
        done={(i) => sections[i]!.files.every((f) => viewed.has(f))}
      />
      <div className="eva-rv-lguide-col">
        {head}
        {guide.source === 'folders' ? (
          <div className="eva-rv-dim eva-rv-small" data-testid="review-guide-fallback">
            Grouped by folder (the walkthrough couldn't be written): {guide.error}
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
                {s.files.map((path) => (
                  <V1FileLink
                    key={path}
                    pr={pr}
                    path={path}
                    viewed={viewed}
                    section={() => refs.current[i]}
                  />
                ))}
              </div>
            </div>
            <div className="eva-rv-lsec-right">
              {s.files.map((path) => (
                <V1FileCard
                  key={path}
                  pr={pr}
                  path={path}
                  diff={diffs.get(path)}
                  reviewed={viewed.has(path)}
                  onViewed={onViewed}
                  onViewInDiff={onViewInDiff}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

function V1FileLink({
  pr,
  path,
  viewed,
  section,
}: {
  pr: ReviewPr
  path: string
  viewed: ReadonlySet<string>
  section: () => HTMLElement | null | undefined
}) {
  const { dir, name } = splitPath(path)
  return (
    <button
      type="button"
      className="eva-rv-lsec-file"
      onClick={() =>
        section()
          ?.querySelector(`[data-gfile="${CSS.escape(path)}"]`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
    >
      <IconFile size={13} className="eva-rv-dim" />
      <span className="eva-rv-ellipsis">
        {name} <span className="eva-rv-dim">{dir.replace(/\/$/, '')}</span>
      </span>
      <span className="eva-rv-spacer" />
      <FileStats pr={pr} path={path} />
      {viewed.has(path) ? <IconCheck size={13} className="eva-rv-accent" /> : null}
    </button>
  )
}

function V1FileCard({
  pr,
  path,
  diff,
  reviewed,
  onViewed,
  onViewInDiff,
}: {
  pr: ReviewPr
  path: string
  diff: DiffFile | undefined
  reviewed: boolean
  onViewed: (path: string, on: boolean) => void
  onViewInDiff: (path: string) => void
}) {
  const { dir, name } = splitPath(path)
  return (
    <div className="eva-rv-gcard" data-gfile={path}>
      <div className="eva-rv-gcard-head">
        <IconFile size={14} className="eva-rv-dim" />
        <span className="eva-rv-ellipsis">
          {name} <span className="eva-rv-dim">{dir}</span>
        </span>
        <span className="eva-rv-spacer" />
        <FileStats pr={pr} path={path} />
        <Checkbox
          size="xs"
          label="Reviewed"
          checked={reviewed}
          onChange={(e) => onViewed(path, e.currentTarget.checked)}
        />
        <FileMenu url={`${pr.url}/files`} onViewInDiff={() => onViewInDiff(path)} />
      </div>
      {reviewed ? null : diff && diff.hunks.length > 0 ? (
        <DiffView hunks={diff.hunks} mode="unified" path={path} />
      ) : (
        <div className="eva-rv-empty">
          {diff?.binary ? 'Binary file' : 'No text changes to show'}
        </div>
      )}
    </div>
  )
}

// ---- v2: overview, concept sections with only their hunks, not covered, checklist ----

/** Ticked indexes kept per PR and head commit (a new push starts a fresh review). */
function useTicks(kind: string, pr: ReviewPr, headSha: string) {
  const [ticks, setTicks] = useLocal<number[]>(`eva-reviews-guide-${kind}:${pr.url}@${headSha}`, [])
  const set = new Set(ticks)
  const toggle = (i: number, on: boolean): void =>
    setTicks(on ? [...ticks.filter((t) => t !== i), i] : ticks.filter((t) => t !== i))
  return [set, toggle] as const
}

function GuideV2({
  pr,
  guide,
  head,
  onViewInDiff,
}: GuideProps & { guide: Guide; head: ReactNode }) {
  const refs = useRef<Array<HTMLElement | null>>([])
  const diffs = useMemo(() => new Map(parseDiff(pr.diff).map((f) => [f.path, f])), [pr.diff])
  // Concept sections only: the hunk-less "Other changed files" section is old clients' copy of notCovered.
  const sections = useMemo(() => guide.sections.filter((s) => (s.hunks?.length ?? 0) > 0), [guide])
  // One cited-range subset per section, kept while the diff is the same (DiffView's highlight cache is per array).
  const code = useMemo(
    () => sections.map((s) => sectionCode(diffs, s.hunks ?? [])),
    [diffs, sections],
  )
  const [savedMode] = usePref<'split' | 'unified' | null>('reviews.diffMode', null, parseDiffMode)
  const [reviewed, setReviewed] = useTicks('sections', pr, guide.headSha)
  const [checked, setChecked] = useTicks('checklist', pr, guide.headSha)
  return (
    <div
      className="eva-rv-lguide"
      data-testid="review-guide"
      data-source={guide.source}
      data-version="2"
    >
      <Ticks sections={sections} refs={refs} done={(i) => reviewed.has(i)} />
      <div className="eva-rv-lguide-col">
        {head}
        <Overview guide={guide} />
        {sections.map((s, i) => (
          <section
            key={i}
            className="eva-rv-lsec"
            ref={(el) => {
              refs.current[i] = el
            }}
            data-testid="review-guide-section"
          >
            <SectionText
              section={s}
              index={i}
              total={sections.length}
              reviewed={reviewed.has(i)}
              onReviewed={(on) => setReviewed(i, on)}
            />
            <div className="eva-rv-lsec-right">
              {code[i]!.files.map((f) => (
                <SectionHunks
                  key={f.path}
                  pr={pr}
                  file={f}
                  mode={savedMode ?? 'unified'}
                  onViewInDiff={onViewInDiff}
                />
              ))}
              <MissingHunks refs={code[i]!.missing} onViewInDiff={onViewInDiff} />
            </div>
          </section>
        ))}
        <GuideEnd
          guide={guide}
          checked={checked}
          onCheck={setChecked}
          onViewInDiff={onViewInDiff}
        />
      </div>
    </div>
  )
}

function Overview({ guide }: { guide: Guide }) {
  const risk = guide.risk ?? 'medium'
  return (
    <div className="eva-rv-goverview" data-testid="review-guide-overview">
      <div className="eva-rv-goverview-risk">
        <Badge color={RISK_COLOR[risk]} variant="light" size="sm">
          {risk} risk
        </Badge>
        {guide.riskWhy ? <span className="eva-rv-dim eva-rv-small">{guide.riskWhy}</span> : null}
      </div>
      {guide.overview ? (
        <div className="eva-rv-lsec-why">
          <Markdown text={guide.overview} />
        </div>
      ) : null}
      {guide.partial ? (
        <div className="eva-rv-dim eva-rv-small" data-testid="review-guide-partial">
          Written from part of the PR: the prompt was cut for size. Files the model didn't see are
          under Not covered.
        </div>
      ) : null}
    </div>
  )
}

/** Citations the loaded diff has no lines for: said, with View in Diff, never dropped silently. */
function MissingHunks({
  refs,
  onViewInDiff,
}: {
  refs: readonly ReviewGuideHunk[]
  onViewInDiff: (path: string) => void
}) {
  if (refs.length === 0) return null
  return (
    <div className="eva-rv-gblock" data-testid="review-guide-missing">
      <div className="eva-rv-dim eva-rv-small">
        Not in the loaded diff (it was cut for size or the PR changed):
      </div>
      {refs.map((r) => (
        <div key={r.id} className="eva-rv-gnot">
          <span className="eva-rv-mono eva-rv-ellipsis">
            {r.path} {r.side === 'old' ? 'old ' : ''}
            {r.start}-{r.end}
          </span>
          <Button size="compact-xs" variant="subtle" onClick={() => onViewInDiff(r.path)}>
            View in Diff
          </Button>
        </div>
      ))}
    </div>
  )
}

function Bullets({ label, items }: { label: string; items: readonly string[] | undefined }) {
  if (!items || items.length === 0) return null
  return (
    <div className="eva-rv-gbullets">
      {label ? <div className="eva-rv-dim eva-rv-small">{label}</div> : null}
      <ul>
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  )
}

function SectionText({
  section,
  index,
  total,
  reviewed,
  onReviewed,
}: {
  section: Section
  index: number
  total: number
  reviewed: boolean
  onReviewed: (on: boolean) => void
}) {
  return (
    <div className="eva-rv-lsec-left">
      <div className="eva-rv-gsec-top">
        <span className="eva-rv-dim eva-rv-small">
          {two(index + 1)} / {two(total)}
        </span>
        <Checkbox
          size="xs"
          label="Reviewed"
          checked={reviewed}
          onChange={(e) => onReviewed(e.currentTarget.checked)}
        />
      </div>
      <h2 className="eva-rv-lsec-title">{section.title}</h2>
      {section.explanation ? (
        <div className="eva-rv-lsec-why">
          <Markdown text={section.explanation} />
        </div>
      ) : null}
      <Bullets label="Check" items={section.check} />
      <Bullets label="Risks" items={section.risks} />
    </div>
  )
}

function Callouts({ items }: { items: readonly GuideCallout[] }) {
  return (
    <div className="eva-rv-callouts">
      {items.map((c, i) => (
        <div key={i} className="eva-rv-callout" data-side={c.side}>
          <span className="eva-rv-mono eva-rv-dim">
            {c.side === 'old' ? 'old ' : ''}
            {c.line}
          </span>
          {c.note}
        </div>
      ))}
    </div>
  )
}

function SectionHunks({
  pr,
  file,
  mode,
  onViewInDiff,
}: {
  pr: ReviewPr
  file: SectionFile
  mode: 'split' | 'unified'
  onViewInDiff: (path: string) => void
}) {
  const { dir, name } = splitPath(file.path)
  return (
    <div className="eva-rv-gcard" data-gfile={file.path}>
      <div className="eva-rv-gcard-head">
        <IconFile size={14} className="eva-rv-dim" />
        <span className="eva-rv-ellipsis">
          {name} <span className="eva-rv-dim">{dir}</span>
        </span>
        <span className="eva-rv-spacer" />
        <FileStats pr={pr} path={file.path} />
        <FileMenu url={`${pr.url}/files`} onViewInDiff={() => onViewInDiff(file.path)} />
      </div>
      <DiffView
        hunks={file.hunks}
        mode={mode}
        path={file.path}
        annotate={(lines) => {
          const items = calloutsFor(file.callouts, lines)
          return items.length > 0 ? <Callouts items={items} /> : null
        }}
      />
    </div>
  )
}

function GuideEnd({
  guide,
  checked,
  onCheck,
  onViewInDiff,
}: {
  guide: Guide
  checked: ReadonlySet<number>
  onCheck: (i: number, on: boolean) => void
  onViewInDiff: (path: string) => void
}) {
  const notCovered = guide.notCovered ?? []
  const checklist = guide.checklist ?? []
  return (
    <div className="eva-rv-gend">
      {notCovered.length > 0 ? (
        <div className="eva-rv-gblock" data-testid="review-guide-not-covered">
          <h2 className="eva-rv-lsec-title">Not covered</h2>
          {notCovered.map((n) => (
            <div key={n.path} className="eva-rv-gnot">
              <span className="eva-rv-mono eva-rv-ellipsis">{n.path}</span>
              <span className="eva-rv-dim eva-rv-small eva-rv-gnot-why">{n.why}</span>
              <Button size="compact-xs" variant="subtle" onClick={() => onViewInDiff(n.path)}>
                View in Diff
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {guide.followUps && guide.followUps.length > 0 ? (
        <div className="eva-rv-gblock">
          <h2 className="eva-rv-lsec-title">Follow-ups</h2>
          <Bullets label="" items={guide.followUps} />
        </div>
      ) : null}
      {checklist.length > 0 ? (
        <div className="eva-rv-gblock" data-testid="review-guide-checklist">
          <h2 className="eva-rv-lsec-title">Review checklist</h2>
          {checklist.map((item, i) => (
            <Checkbox
              key={i}
              size="xs"
              label={item}
              checked={checked.has(i)}
              onChange={(e) => onCheck(i, e.currentTarget.checked)}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
