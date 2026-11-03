import { useEffect, useState, type ReactNode } from 'react'
import { ActionIcon, Progress, SegmentedControl, Tooltip, UnstyledButton } from '@mantine/core'
import {
  IconActivity,
  IconCalendarTime,
  IconChevronRight,
  IconCircleCheck,
  IconCircleX,
  IconClipboardList,
  IconEye,
  IconFileDiff,
  IconFlask,
  IconFolder,
  IconGitBranch,
  IconGitCommit,
  IconGitPullRequest,
  IconHandStop,
  IconLoader2,
  IconMessage,
  IconMessageCircle,
  IconPin,
  IconPinnedOff,
  IconProgress,
  IconRoute,
} from '@tabler/icons-react'
import { placeOf } from '@evaos/shell-core'
import {
  pinId,
  type ContextAction,
  type ContextOpen,
  type ContextRow,
  type ContextSnapshot,
} from '@evaos/contract'
import { EvaPopover } from '../overlay'
import { navigateTo } from '../tabs/tabs-store'
import { openLink } from '../navigation/open-link'
import { openSubagentTab, revealTool } from '../tiling/tiling-store'
import { showPath } from '../files/files-store'
import { chatStore } from '../chat/chat-store'
import { PANE_ID } from '../chat/open-chat'
import { fillComposer } from '../chat/composer-fill'
import { requestExperiment } from '../test-bench/bench-request'
import {
  pinContext,
  setContextOpen,
  setContextScope,
  unpinContext,
  useContextStore,
} from './context-store'
import { clockLabel, dayLabel, elapsedLabel } from './format'
import './context.css'

const ICONS: Record<ContextRow['icon'], typeof IconActivity> = {
  pr: IconGitPullRequest,
  branch: IconGitBranch,
  checks: IconCircleCheck,
  'checks-failed': IconCircleX,
  'checks-pending': IconProgress,
  review: IconMessageCircle,
  diff: IconFileDiff,
  stage: IconRoute,
  running: IconLoader2,
  needs: IconHandStop,
  done: IconCircleCheck,
  failed: IconCircleX,
  experiment: IconFlask,
  job: IconCalendarTime,
  item: IconClipboardList,
  chat: IconMessage,
  ready: IconEye,
}

const BUTTON_ICONS: Record<ContextSnapshot['button']['icon'], typeof IconActivity> = {
  pr: IconGitPullRequest,
  branch: IconGitBranch,
  activity: IconActivity,
}

const DOT_TEXT: Record<NonNullable<ContextSnapshot['button']['dot']>, string> = {
  needs: 'needs you',
  failing: 'checks failing',
  running: 'running',
}

/** Re-renders every 30 s while `active`, so elapsed times stay current. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [active])
  return now
}

function openTarget(open: ContextOpen): void {
  switch (open.kind) {
    case 'url':
      openLink(open.url)
      break
    case 'files':
      revealTool('files')
      void showPath(open.path, chatStore.getState().panes[PANE_ID]?.file || null)
      break
    case 'chat':
      navigateTo(placeOf('chat', { chat: open.file }))
      break
    case 'subagent':
      openSubagentTab({ session: open.session, file: open.file, name: open.name })
      break
    case 'experiment':
      requestExperiment(open.id)
      navigateTo(placeOf('test-bench'))
      break
    case 'jobs':
      navigateTo(placeOf('jobs'))
      break
  }
}

function Right({ row, now }: { row: ContextRow; now: number }) {
  const parts: ReactNode[] = []
  if (row.diff) {
    parts.push(
      <span key="diff" className="eva-ctx-diff">
        <span className="eva-ctx-add">+{row.diff.add}</span>
        <span className="eva-ctx-del">-{row.diff.del}</span>
      </span>,
    )
  }
  if (row.meta) {
    parts.push(
      <span key="meta" className="eva-ctx-num">
        {row.meta}
      </span>,
    )
  }
  if (row.time) {
    parts.push(
      <span key="time" className="eva-ctx-num">
        {row.time.style === 'elapsed'
          ? elapsedLabel(row.time.at, now)
          : row.time.style === 'day'
            ? dayLabel(row.time.at, now)
            : clockLabel(row.time.at, now)}
      </span>,
    )
  }
  if (row.pill) {
    parts.push(
      <span key="pill" className="eva-ctx-pill" data-tone={row.pill.tone}>
        {row.pill.label}
      </span>,
    )
  }
  if (parts.length === 0) return null
  return <span className="eva-ctx-right">{parts}</span>
}

function Row({
  row,
  pinned,
  now,
  onOpen,
}: {
  row: ContextRow
  /** The row is in Pinned, or its target is pinned. */
  pinned: boolean
  now: number
  onOpen: () => void
}) {
  const Icon = ICONS[row.icon]
  const pin = row.pin
  const [busy, setBusy] = useState(false)
  const label = pinned ? 'Unpin' : 'Pin'
  const togglePin = async (): Promise<void> => {
    if (!pin || busy) return
    setBusy(true)
    try {
      if (pinned) await unpinContext(pinId(pin))
      else await pinContext(pin)
    } finally {
      setBusy(false)
    }
  }
  const body = (
    <>
      <Icon
        size={16}
        stroke={1.5}
        className="eva-ctx-icon"
        data-tone={row.tone}
        data-spin={row.icon === 'running' ? 'true' : undefined}
        aria-hidden
      />
      <span className="eva-ctx-text">
        {/* Long values truncate; the full text is one hover away. */}
        <span className="eva-ctx-title" data-mono={row.mono ? 'true' : undefined} title={row.title}>
          {row.title}
        </span>
        {row.sub ? (
          <span className="eva-ctx-sub" title={row.sub}>
            {row.sub}
          </span>
        ) : null}
        {row.progress ? (
          <Progress
            className="eva-ctx-progress"
            size={4}
            value={(row.progress.done / row.progress.total) * 100}
            aria-label={`${row.progress.done} of ${row.progress.total}`}
          />
        ) : null}
      </span>
      <Right row={row} now={now} />
    </>
  )
  return (
    <div
      className="eva-ctx-row"
      data-testid={`context-row-${row.id}`}
      data-pinnable={pin ? 'true' : undefined}
      data-two-line={row.sub || row.progress ? 'true' : undefined}
    >
      {row.open ? (
        <UnstyledButton className="eva-ctx-main" onClick={onOpen}>
          {body}
        </UnstyledButton>
      ) : (
        <div className="eva-ctx-main">{body}</div>
      )}
      {pin ? (
        <Tooltip label={label} position="left" openDelay={300} withinPortal zIndex={400}>
          <ActionIcon
            variant="subtle"
            size={24}
            className="eva-ctx-pin"
            aria-label={`${label} ${row.title}`}
            aria-pressed={pinned}
            data-testid={`context-pin-${row.id}`}
            loading={busy}
            onClick={() => void togglePin()}
          >
            {pinned ? <IconPinnedOff size={14} stroke={1.5} /> : <IconPin size={14} stroke={1.5} />}
          </ActionIcon>
        </Tooltip>
      ) : null}
    </div>
  )
}

const ACTION_LOOK: Record<ContextAction['id'], { label: string; Icon: typeof IconActivity }> = {
  'open-pr': { label: 'Open PR', Icon: IconGitPullRequest },
  'open-files': { label: 'Open in Files', Icon: IconFolder },
  'commit-push': { label: 'Commit & push', Icon: IconGitCommit },
}

function runAction(a: ContextAction): void {
  if (a.id === 'open-pr') openLink(a.url)
  else if (a.id === 'open-files') {
    revealTool('files')
    void showPath(a.path, chatStore.getState().panes[PANE_ID]?.file || null)
  } else fillComposer(PANE_ID, a.prompt)
}

const ACTION_TIPS: Record<ContextAction['id'], string> = {
  'open-pr': 'Opens the pull request in the browser panel',
  'open-files': "Shows this chat's worktree in the Files panel",
  'commit-push': 'Puts a commit and push request in the message box. You send it.',
}

function Popover({ snap, now }: { snap: ContextSnapshot; now: number }) {
  const pinnedIds = new Set(snap.pinned.flatMap((r) => (r.pin ? [pinId(r.pin)] : [])))
  // Folded sections (Resolved) Isaac opened while the popover shows.
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (id: string): void =>
    setUnfolded((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const close = (): void => setContextOpen(false)
  const open = (row: ContextRow): void => {
    if (!row.open) return
    close()
    openTarget(row.open)
  }
  const hereLabel = snap.kind === 'assistant' ? 'This thread' : 'This chat'
  const f = snap.footer
  const jobsText =
    f.jobsRunning > 0 || f.jobsScheduled > 0
      ? `Jobs: ${[f.jobsRunning > 0 ? `${f.jobsRunning} running` : null, f.jobsScheduled > 0 ? `${f.jobsScheduled} scheduled` : null].filter(Boolean).join(', ')}`
      : 'Jobs: none running'
  const benchText = `Test Bench: ${f.benchRunning === 0 ? 'idle' : `${f.benchRunning} ${f.benchRunning === 1 ? 'run' : 'runs'}`}`
  const empty = snap.pinned.length === 0 && snap.sections.length === 0
  return (
    <div className="eva-ctx-pop" data-testid="context-popover">
      {snap.kind !== 'none' ? (
        <SegmentedControl
          className="eva-ctx-scope"
          size="xs"
          fullWidth
          styles={{ indicator: { boxShadow: 'none' } }}
          value={snap.scope}
          onChange={(v) => setContextScope(v === 'everywhere' ? 'everywhere' : 'here')}
          data={[
            { value: 'here', label: hereLabel },
            { value: 'everywhere', label: 'Everywhere' },
          ]}
          data-testid="context-scope"
        />
      ) : null}
      {snap.pinned.length > 0 ? (
        <section className="eva-ctx-section" data-testid="context-pinned">
          <h3 className="eva-ctx-head">Pinned</h3>
          {snap.pinned.map((r) => (
            <Row key={r.id} row={r} pinned now={now} onOpen={() => open(r)} />
          ))}
        </section>
      ) : null}
      {snap.sections.map((s) => {
        const shown = !s.fold || unfolded.has(s.id)
        return (
          <section key={s.id} className="eva-ctx-section" data-testid={`context-section-${s.id}`}>
            <h3 className="eva-ctx-head">
              {s.fold ? (
                <UnstyledButton
                  className="eva-ctx-fold"
                  aria-expanded={shown}
                  data-testid={`context-fold-${s.id}`}
                  onClick={() => toggle(s.id)}
                >
                  <span>{s.title}</span>
                  <span className="eva-ctx-fold-end">
                    {s.meta ? <span className="eva-ctx-head-meta">{s.meta}</span> : null}
                    <IconChevronRight
                      size={14}
                      stroke={1.5}
                      className="eva-ctx-chevron"
                      data-open={shown ? 'true' : undefined}
                      aria-hidden
                    />
                  </span>
                </UnstyledButton>
              ) : (
                <>
                  <span>{s.title}</span>
                  {s.meta ? <span className="eva-ctx-head-meta">{s.meta}</span> : null}
                </>
              )}
            </h3>
            {shown
              ? s.rows.map((r) => (
                  <Row
                    key={r.id}
                    row={r}
                    pinned={r.pin !== null && pinnedIds.has(pinId(r.pin))}
                    now={now}
                    onOpen={() => open(r)}
                  />
                ))
              : null}
          </section>
        )
      })}
      {empty ? (
        <p className="eva-ctx-empty" data-testid="context-empty">
          {snap.scope === 'here'
            ? 'Nothing is running here. Hover a row anywhere to pin it to the top.'
            : 'Nothing is running and nothing waits on you.'}
        </p>
      ) : null}
      {snap.actions.length > 0 ? (
        <div className="eva-ctx-actions" data-testid="context-actions">
          {snap.actions.map((a) => {
            const { label, Icon } = ACTION_LOOK[a.id]
            return (
              <Tooltip
                key={a.id}
                label={ACTION_TIPS[a.id]}
                openDelay={400}
                withinPortal
                zIndex={400}
              >
                <UnstyledButton
                  className="eva-ctx-action"
                  data-testid={`context-action-${a.id}`}
                  onClick={() => {
                    close()
                    runAction(a)
                  }}
                >
                  <Icon size={14} stroke={1.5} aria-hidden />
                  {label}
                </UnstyledButton>
              </Tooltip>
            )
          })}
        </div>
      ) : (
        <div className="eva-ctx-foot" data-testid="context-footer">
          <UnstyledButton
            className="eva-ctx-foot-link"
            onClick={() => {
              close()
              navigateTo(placeOf('jobs'))
            }}
          >
            <IconCalendarTime size={14} stroke={1.5} aria-hidden />
            {jobsText}
          </UnstyledButton>
          <UnstyledButton
            className="eva-ctx-foot-link"
            onClick={() => {
              close()
              navigateTo(placeOf('test-bench'))
            }}
          >
            <IconFlask size={14} stroke={1.5} aria-hidden />
            {benchText}
          </UnstyledButton>
        </div>
      )}
    </div>
  )
}

/** Header button left of the panel toggle: the headline here, and the context popover. */
export function ContextButton() {
  const snap = useContextStore((s) => s.snapshot)
  const open = useContextStore((s) => s.open)
  const now = useNow(open)
  if (snap === null) return null
  const { icon, label, dot, summary } = snap.button
  const Icon = BUTTON_ICONS[icon]
  const aria = dot ? `${summary} (${DOT_TEXT[dot]})` : summary
  return (
    <EvaPopover
      opened={open}
      onChange={setContextOpen}
      position="bottom-end"
      width={360}
      testid="context-button-target"
    >
      <EvaPopover.Target>
        <Tooltip label={summary} position="bottom" openDelay={400} disabled={open}>
          <UnstyledButton
            className="eva-header-btn eva-ctx-btn"
            data-testid="context-button"
            data-labelled={label ? 'true' : undefined}
            data-open={open ? 'true' : undefined}
            aria-label={aria}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setContextOpen(!open)}
          >
            <Icon size={15} stroke={1.5} aria-hidden />
            {label ? <span className="eva-ctx-btn-label">{label}</span> : null}
            {dot ? <span className="eva-ctx-dot" data-dot={dot} aria-hidden /> : null}
          </UnstyledButton>
        </Tooltip>
      </EvaPopover.Target>
      <EvaPopover.Dropdown>
        <Popover snap={snap} now={now} />
      </EvaPopover.Dropdown>
    </EvaPopover>
  )
}
