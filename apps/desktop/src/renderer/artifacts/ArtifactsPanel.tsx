import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ActionIcon, Button, Scroller, TextInput, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconAlertCircle,
  IconArrowBarToLeft,
  IconArrowBarToRight,
  IconBug,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCircleCheck,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconFile,
  IconFilter,
  IconFlask,
  IconFolder,
  IconGitPullRequest,
  IconLayout,
  IconLink,
  IconListDetails,
  IconPencil,
  IconPhoto,
  IconPin,
  IconPinnedOff,
  IconSubtask,
  IconRocket,
  IconSearch,
  IconStack2,
  IconStar,
  IconTicket,
  IconVideo,
  IconX,
} from '@tabler/icons-react'
import { placeOf } from '@evaos/shell-core'
import {
  defaultTabs,
  isDefaultTab,
  ruleMatches,
  subagentView,
  tidyIds,
  tabItems,
  visibleTabs,
  type Artifact,
  type ArtifactTab,
  type ArtifactTabIcon,
  type TabRule,
} from '@evaos/chat-core/artifacts'
import { AgentPortrait } from '../assistants/AgentPortrait'
import { chatStore, useChatStore } from '../chat/chat-store'
import { PANE_ID } from '../chat/open-chat'
import { agentTitle, useNamesVersion } from '../eva/names-store'
import { showPath } from '../files/files-store'
import { invoke } from '../ipc'
import { openLink } from '../navigation/open-link'
import { openPlace } from '../navigation/navigate'
import { EvaMenu } from '../overlay'
import { openSubagentTab, revealTool, useTiling } from '../tiling/tiling-store'
import { requestExperiment } from '../test-bench/bench-request'
import { ArtifactRow, RowButton, type RowActions } from './ArtifactRow'
import { MediaGrid, MediaLightbox } from './ArtifactsMedia'
import {
  actorName,
  ageText,
  anyRunning,
  withTranscripts,
  externalUrl,
  linkGroups,
  mediaTiles,
  movedIndex,
  openTarget,
  ruleChips,
  searchItems,
  subagentTree,
  tabOrigin,
  watchTarget,
  whenText,
  type TreeRow,
} from './artifacts-model'
import {
  act,
  dismissNotice,
  setActiveTab,
  setShowTidied,
  startArtifacts,
  useArtifacts,
  useArtifactsThread,
} from './artifacts-store'
import { RenameDialog, RuleDialog } from './TabDialogs'
import './artifacts.css'

const ICON = { size: 16, stroke: 1.5 } as const

const TAB_ICONS: Readonly<Record<ArtifactTabIcon, typeof IconLink>> = {
  subtask: IconSubtask,
  link: IconLink,
  photo: IconPhoto,
  stack: IconStack2,
  'git-pull-request': IconGitPullRequest,
  ticket: IconTicket,
  file: IconFile,
  flask: IconFlask,
  layout: IconLayout,
  star: IconStar,
  check: IconCheck,
  video: IconVideo,
  bug: IconBug,
  rocket: IconRocket,
}

/** The clock rows read; ticks each minute so ages and "today" stay right. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])
  return now
}

const nameOf = (by: string): string => actorName(by, agentTitle)
const isAgent = (by: string): boolean => agentTitle(by) !== null

/** A tab's mark: the maker's portrait on an agent's tab, else its icon. */
function TabMark({ tab, spinning }: { tab: ArtifactTab; spinning: boolean }) {
  if (spinning) return <span className="eva-spinner" aria-hidden="true" />
  if (!isDefaultTab(tab.id) && isAgent(tab.createdBy)) {
    return <AgentPortrait id={tab.createdBy} className="eva-art-tab-portrait" />
  }
  const Icon = TAB_ICONS[tab.icon ?? 'stack']
  return <Icon {...ICON} />
}

function Empty({
  icon,
  title,
  children,
}: {
  icon: ReactNode
  title: string
  children?: ReactNode
}) {
  return (
    <div className="eva-art-empty" data-testid="artifacts-empty">
      <span className="eva-art-empty-icon">{icon}</span>
      <span className="eva-art-empty-title">{title}</span>
      {children ? <span className="eva-art-empty-text">{children}</span> : null}
    </div>
  )
}

function SearchBar({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <div className="eva-art-toolbar">
      <TextInput
        className="eva-art-search"
        size="xs"
        leftSection={<IconSearch size={14} stroke={1.5} />}
        placeholder={placeholder}
        aria-label={placeholder}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        rightSection={
          value !== '' ? (
            <ActionIcon
              variant="subtle"
              color="gray"
              size="xs"
              aria-label="Clear search"
              onClick={() => onChange('')}
            >
              <IconX size={12} stroke={1.5} />
            </ActionIcon>
          ) : null
        }
        data-testid="artifacts-search"
      />
    </div>
  )
}

interface ViewProps {
  thread: string
  tab: ArtifactTab
  /** Every item the thread holds, faded ones too (search finds them). */
  items: readonly Artifact[]
  rows: readonly Artifact[]
  byId: ReadonlyMap<string, Artifact>
  now: number
  actions: RowActions
  onOpenMedia: (list: readonly Artifact[], index: number) => void
  onEditRule: (tab: ArtifactTab) => void
}

function Rows({
  rows,
  byId,
  now,
  actions,
}: Pick<ViewProps, 'byId' | 'now' | 'actions'> & { rows: readonly Artifact[] }) {
  return (
    <>
      {rows.map((item) => (
        <ArtifactRow
          key={item.id}
          item={item}
          byId={byId}
          now={now}
          pinnedBy={item.pinned ? nameOf(item.pinned.by) : null}
          actions={actions}
        />
      ))}
    </>
  )
}

function LinksView({ tab, items, rows, byId, now, actions }: ViewProps) {
  const [query, setQuery] = useState('')
  // Search reaches faded links too: every item the Links rule takes.
  const pool =
    query.trim() === ''
      ? rows
      : searchItems(
          items.filter((i) => ruleMatches(tab.rule ?? {}, i)),
          query,
        )
  const groups = linkGroups(pool)
  return (
    <>
      <SearchBar value={query} onChange={setQuery} placeholder="Search links" />
      <div className="eva-art-scroll">
        {groups.length === 0 ? (
          query.trim() !== '' ? (
            <Empty icon={<IconSearch size={20} stroke={1.5} />} title="Nothing matches">
              Try other words.
            </Empty>
          ) : (
            <Empty icon={<IconLink size={20} stroke={1.5} />} title="No links yet">
              Tickets, PRs and web links this thread mentions land here, one row each.
            </Empty>
          )
        ) : (
          groups.map((g, i) => (
            <section key={g.key} className="eva-art-group" aria-label={g.label}>
              <h3 className="eva-art-group-label">
                <span>{g.label}</span>
                {i === (groups[0]?.key === 'pinned' ? 1 : 0) ? (
                  <span className="eva-art-group-note">last mention first</span>
                ) : null}
              </h3>
              <Rows rows={g.rows} byId={byId} now={now} actions={actions} />
            </section>
          ))
        )}
      </div>
    </>
  )
}

function MediaView({
  items,
  rows,
  now,
  onOpenMedia,
  placeholder,
  ruled = false,
}: ViewProps & { placeholder: string; ruled?: boolean }) {
  const [query, setQuery] = useState('')
  const pool =
    query.trim() === ''
      ? rows
      : searchItems(
          items.filter((i) => i.media !== undefined),
          query,
        )
  const tiles = mediaTiles(pool)
  return (
    <>
      <SearchBar value={query} onChange={setQuery} placeholder={placeholder} />
      <div className="eva-art-scroll">
        {tiles.length === 0 ? (
          query.trim() !== '' ? (
            <Empty icon={<IconSearch size={20} stroke={1.5} />} title="Nothing matches">
              Try other words.
            </Empty>
          ) : ruled ? (
            <Empty
              icon={<IconFilter size={20} stroke={1.5} />}
              title="Nothing matches this rule yet"
            >
              It fills by itself as the thread brings in matching media.
            </Empty>
          ) : (
            <Empty icon={<IconPhoto size={20} stroke={1.5} />} title="No media yet">
              Drops and images pasted into this thread show up here.
            </Empty>
          )
        ) : (
          <MediaGrid tiles={tiles} now={now} onOpen={(i) => onOpenMedia(tiles, i)} />
        )}
      </div>
    </>
  )
}

function SubagentRow({ row, now, actions }: { row: TreeRow; now: number; actions: RowActions }) {
  const { item, depth } = row
  const sub = item.subagent
  const state = subagentView(item, now)
  const running = state === 'running'
  const line = sub?.line ?? (sub ? `Started ${whenText(sub.startedAt, now)}` : '')
  const right =
    running && sub
      ? ageText(sub.startedAt, now)
      : sub?.endedAt !== undefined
        ? whenText(sub.endedAt, now)
        : ''
  return (
    <div
      className="eva-art-row eva-art-sub"
      role="button"
      tabIndex={0}
      style={{ paddingLeft: `calc(var(--eva-space-md) + ${depth} * 24px)` }}
      data-testid={`artifact-row-${item.id}`}
      data-state={state ?? undefined}
      onClick={() => actions.open(item)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') actions.open(item)
      }}
    >
      <span className="eva-art-row-icon">
        {running ? (
          <span className="eva-spinner" aria-label="Running" />
        ) : state === 'failed' ? (
          <IconAlertCircle {...ICON} data-tone="red" aria-label="Failed" />
        ) : (
          <IconCircleCheck {...ICON} data-tone="green" aria-label="Done" />
        )}
      </span>
      <span className="eva-art-row-text">
        <span className="eva-art-row-title">
          <span className="eva-art-title-text">{item.title}</span>
        </span>
        {line !== '' ? <span className="eva-art-row-meta">{line}</span> : null}
      </span>
      <span className="eva-art-row-when">{right}</span>
      <span className="eva-art-row-actions">
        <RowButton label="Open the transcript in the panel" onClick={() => actions.open(item)}>
          <IconListDetails {...ICON} />
        </RowButton>
        <RowButton
          label={item.pinned ? 'Unpin' : 'Keep it past today'}
          onClick={() => actions.pin(item, item.pinned === undefined)}
        >
          {item.pinned ? <IconPinnedOff {...ICON} /> : <IconPin {...ICON} />}
        </RowButton>
      </span>
    </div>
  )
}

function SubagentsView({ rows, now, actions }: ViewProps) {
  const { running, finished } = subagentTree(rows, now)
  return (
    <div className="eva-art-scroll">
      {running.length + finished.length === 0 ? (
        <Empty icon={<IconSubtask size={20} stroke={1.5} />} title="No subagents today">
          Subagents this thread starts show here while they run and for the rest of the day.
        </Empty>
      ) : null}
      {running.length > 0 ? (
        <section className="eva-art-group" aria-label="Running">
          <h3 className="eva-art-group-label">Running</h3>
          {running.map((r) => (
            <SubagentRow key={r.item.id} row={r} now={now} actions={actions} />
          ))}
        </section>
      ) : null}
      {finished.length > 0 ? (
        <section className="eva-art-group" aria-label="Finished today">
          <h3 className="eva-art-group-label">Finished today</h3>
          {finished.map((r) => (
            <SubagentRow key={r.item.id} row={r} now={now} actions={actions} />
          ))}
        </section>
      ) : null}
    </div>
  )
}

/** An agent's tab: its rule as chips, who made it and when, and Edit rule. */
function RuleHeader({
  tab,
  now,
  onEditRule,
}: {
  tab: ArtifactTab
  now: number
  onEditRule: () => void
}) {
  const chips = tab.rule ? ruleChips(tab.rule) : []
  const maker = nameOf(tab.createdBy)
  return (
    <div className="eva-art-rule" data-testid="artifacts-rule-header">
      <div className="eva-art-rule-line">
        <IconFilter size={14} stroke={1.5} />
        {tab.items !== undefined ? (
          <span>{`Shows ${tab.items.length} picked by hand`}</span>
        ) : chips.length === 0 ? (
          <span>Shows everything</span>
        ) : (
          <>
            <span>Shows</span>
            {chips.map((c, i) => (
              <span key={c} className="eva-art-rule-chipwrap">
                {i > 0 ? <span className="eva-art-rule-and">and</span> : null}
                <span className="eva-art-rule-chip">{c}</span>
              </span>
            ))}
          </>
        )}
        {tab.rule !== undefined ? (
          <button
            type="button"
            className="eva-art-link"
            onClick={onEditRule}
            data-testid="artifacts-edit-rule"
          >
            Edit rule
          </button>
        ) : null}
      </div>
      <div className="eva-art-rule-by">
        {isAgent(tab.createdBy) ? (
          <AgentPortrait id={tab.createdBy} className="eva-art-tab-portrait" />
        ) : null}
        <span>{tabOrigin(tab, maker, now)}</span>
      </div>
    </div>
  )
}

function ListView(props: ViewProps) {
  const { tab, items, rows, byId, now, actions, onEditRule } = props
  const [query, setQuery] = useState('')
  const own = !isDefaultTab(tab.id)
  const media = tab.rule?.media === true
  if (media) {
    return (
      <>
        {own ? <RuleHeader tab={tab} now={now} onEditRule={() => onEditRule(tab)} /> : null}
        <MediaView
          {...props}
          ruled={own}
          placeholder={`Search ${isDefaultTab(tab.id) ? tab.title.toLowerCase() : tab.title}`}
        />
      </>
    )
  }
  const shown = query.trim() === '' ? rows : searchItems(own ? rows : items, query)
  return (
    <>
      {own ? <RuleHeader tab={tab} now={now} onEditRule={() => onEditRule(tab)} /> : null}
      <SearchBar
        value={query}
        onChange={setQuery}
        placeholder={`Search ${isDefaultTab(tab.id) ? tab.title.toLowerCase() : tab.title}`}
      />
      <div className="eva-art-scroll">
        {shown.length === 0 ? (
          query.trim() !== '' ? (
            <Empty icon={<IconSearch size={20} stroke={1.5} />} title="Nothing matches">
              Try other words.
            </Empty>
          ) : own ? (
            <Empty
              icon={<IconFilter size={20} stroke={1.5} />}
              title="Nothing matches this rule yet"
            >
              It fills by itself as the thread brings in matching items.
            </Empty>
          ) : (
            <Empty icon={<IconStack2 size={20} stroke={1.5} />} title="Nothing here yet">
              Links, media, files and subagents this thread brings in collect here.
            </Empty>
          )
        ) : (
          <>
            <div className="eva-art-count">{`${shown.length} ${shown.length === 1 ? 'item' : 'items'}, last activity first`}</div>
            <Rows rows={shown} byId={byId} now={now} actions={actions} />
          </>
        )}
      </div>
    </>
  )
}

interface TabMenuState {
  tab: ArtifactTab
  x: number
  y: number
}

function TabMenu({
  menu,
  tabs,
  now,
  onClose,
  onRename,
  onEditRule,
  update,
}: {
  menu: TabMenuState | null
  tabs: readonly ArtifactTab[]
  now: number
  onClose: () => void
  onRename: (tab: ArtifactTab) => void
  onEditRule: (tab: ArtifactTab) => void
  update: (tab: ArtifactTab, patch: { index?: number; hidden?: boolean }) => void
}) {
  const tab = menu?.tab
  const left = tab ? movedIndex(tabs, tab.id, -1) : null
  const right = tab ? movedIndex(tabs, tab.id, 1) : null
  const maker = tab ? nameOf(tab.createdBy) : ''
  const agentTab = tab !== undefined && !isDefaultTab(tab.id) && tab.createdBy !== 'isaac'
  return createPortal(
    <EvaMenu
      opened={menu !== null}
      onChange={(o) => {
        if (!o) onClose()
      }}
      width={300}
      position="bottom-start"
      offset={0}
    >
      <EvaMenu.Target>
        <span
          className="eva-art-menu-anchor"
          style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
          aria-hidden
        />
      </EvaMenu.Target>
      <EvaMenu.Dropdown data-testid="artifacts-tab-menu">
        {tab ? (
          <>
            <EvaMenu.Item
              leftSection={<IconPencil {...ICON} />}
              onClick={() => onRename(tab)}
              data-testid="artifacts-tab-rename"
            >
              Rename
            </EvaMenu.Item>
            {tab.rule !== undefined && tab.id !== 'everything' ? (
              <EvaMenu.Item leftSection={<IconFilter {...ICON} />} onClick={() => onEditRule(tab)}>
                Edit rule
              </EvaMenu.Item>
            ) : null}
            <EvaMenu.Item
              leftSection={<IconArrowBarToLeft {...ICON} />}
              disabled={left === null}
              onClick={() => left !== null && update(tab, { index: left })}
            >
              Move left
            </EvaMenu.Item>
            <EvaMenu.Item
              leftSection={<IconArrowBarToRight {...ICON} />}
              disabled={right === null}
              onClick={() => right !== null && update(tab, { index: right })}
            >
              Move right
            </EvaMenu.Item>
            <EvaMenu.Item
              leftSection={<IconPin {...ICON} />}
              disabled={tabs[0]?.id === tab.id}
              onClick={() => update(tab, { index: 0 })}
            >
              Pin tab first
            </EvaMenu.Item>
            <EvaMenu.Divider />
            <EvaMenu.Item
              leftSection={<IconEyeOff {...ICON} />}
              rightSection={
                agentTab ? (
                  <span className="eva-art-menu-hint">{`${maker} can't re-add it`}</span>
                ) : null
              }
              onClick={() => update(tab, { hidden: true })}
              data-testid="artifacts-tab-hide"
            >
              Hide tab
            </EvaMenu.Item>
            <EvaMenu.Divider />
            <div className="eva-art-menu-footer">
              <span>{tabOrigin(tab, maker, now)}</span>
              {tab.rule && Object.keys(tab.rule).length > 0 ? (
                <span>{`Rule: ${ruleChips(tab.rule).join(', ')}`}</span>
              ) : null}
            </div>
          </>
        ) : null}
      </EvaMenu.Dropdown>
    </EvaMenu>,
    document.body,
  )
}

function ItemMenu({
  menu,
  onClose,
}: {
  menu: { item: Artifact; x: number; y: number } | null
  onClose: () => void
}) {
  const item = menu?.item
  const url = item ? externalUrl(item) : null
  const path = item?.path
  return createPortal(
    <EvaMenu
      opened={menu !== null}
      onChange={(o) => {
        if (!o) onClose()
      }}
      width={220}
      position="bottom-start"
      offset={0}
    >
      <EvaMenu.Target>
        <span
          className="eva-art-menu-anchor"
          style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
          aria-hidden
        />
      </EvaMenu.Target>
      <EvaMenu.Dropdown data-testid="artifacts-item-menu">
        {url !== null ? (
          <EvaMenu.Item
            leftSection={<IconCopy {...ICON} />}
            onClick={() => void navigator.clipboard.writeText(url)}
          >
            Copy link
          </EvaMenu.Item>
        ) : null}
        {path !== undefined ? (
          <>
            <EvaMenu.Item
              leftSection={<IconCopy {...ICON} />}
              onClick={() => void navigator.clipboard.writeText(path)}
            >
              Copy path
            </EvaMenu.Item>
            <EvaMenu.Item
              leftSection={<IconFolder {...ICON} />}
              onClick={() => {
                revealTool('files')
                void showPath(path, chatStore.getState().panes[PANE_ID]?.file || null)
              }}
            >
              Show in Files
            </EvaMenu.Item>
          </>
        ) : null}
        <EvaMenu.Item
          leftSection={<IconCopy {...ICON} />}
          onClick={() => item && void navigator.clipboard.writeText(item.title)}
        >
          Copy title
        </EvaMenu.Item>
      </EvaMenu.Dropdown>
    </EvaMenu>,
    document.body,
  )
}

/**
 * The Artifacts panel: what the thread in front holds (the assistant page's thread, or the
 * chat's), in tabs. The four defaults come first, agents' tabs after; a tab's rows come from
 * `tabItems`, the rule the phone uses too.
 */
export function ArtifactsPanel({ hidden }: { hidden: boolean }) {
  useEffect(() => startArtifacts(), [])
  useNamesVersion()
  const scope = useTiling((s) => s.scope)
  const target = useMemo(() => watchTarget(scope), [scope])
  const thread = useArtifactsThread(target, !hidden)
  const view = useArtifacts((s) => (thread ? s.threads[thread] : undefined))
  const up = useArtifacts((s) => s.up)
  const activeId = useArtifacts((s) => (thread ? s.active[thread] : undefined))
  const notice = useArtifacts((s) => s.notices.find((n) => n.thread === thread))
  const now = useNow()
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null)
  const [allOpen, setAllOpen] = useState(false)
  const [itemMenu, setItemMenu] = useState<{ item: Artifact; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<ArtifactTab | null>(null)
  const [ruling, setRuling] = useState<ArtifactTab | null>(null)
  const [lightbox, setLightbox] = useState<{ list: readonly Artifact[]; index: number } | null>(
    null,
  )

  const tabs = view && view.tabs.length > 0 ? view.tabs : defaultTabs()
  const shownTabs = visibleTabs(tabs)
  const tab = shownTabs.find((t) => t.id === activeId) ?? shownTabs[0]
  const chatPane = useChatStore((s) => s.panes[PANE_ID])
  const hostItems = view?.items
  // The open chat's subagents are read from its transcripts too, the facts the context button's
  // dot uses, so the tab's spinner, this list and that dot agree.
  const allItems = useMemo(() => {
    const base = hostItems ?? []
    return target !== null && target.file !== '' && chatPane?.file === target.file
      ? withTranscripts(base, target.file, chatPane.extras.subagents, now)
      : base
  }, [hostItems, target, chatPane?.file, chatPane?.extras.subagents, now])
  const showTidied = useArtifacts((s) => (thread ? s.showTidied[thread] === true : false))
  // Items Tidy hid (the host keeps that, so the phone sees the same) stay out of every tab unless
  // "Show tidied" is on; a running subagent never hides.
  const items = useMemo(
    () =>
      showTidied
        ? allItems
        : allItems.filter((i) => i.tidied === undefined || subagentView(i, now) === 'running'),
    [allItems, showTidied, now],
  )
  const tidiedCount = allItems.filter((i) => i.tidied !== undefined).length
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  // The Subagents tab's spinner and its list both read the rows that tab shows, through subagentView.
  const subagentsTab = tabs.find((t) => t.id === 'subagents')
  const running = anyRunning(
    subagentsTab ? tabItems(subagentsTab, items, now).filter((i) => i.kind === 'subagent') : [],
    now,
  )

  const tidy = async (): Promise<void> => {
    if (!thread) return
    const ids = tidyIds(allItems, now)
    if (ids.length === 0) {
      notifications.show({
        title: 'Nothing to tidy',
        message: 'Everything here is running, pinned or recent.',
      })
      return
    }
    // The host's answer decides: a refusal already toasted its reason, so no "Tidied" on top.
    if (!(await act(thread, { op: 'tidy', ids, tidied: true })).ok) return
    const id = `artifacts-tidy-${Date.now()}`
    notifications.show({
      id,
      autoClose: 8000,
      title: `Tidied ${ids.length} ${ids.length === 1 ? 'item' : 'items'}`,
      message: (
        <Button
          size="compact-xs"
          variant="subtle"
          data-testid="artifacts-tidy-undo"
          onClick={() => {
            void act(thread, { op: 'tidy', ids, tidied: false })
            notifications.hide(id)
          }}
        >
          Undo
        </Button>
      ),
    })
  }

  const openTab = (t: ArtifactTab): void => {
    if (!thread) return
    setActiveTab(thread, t.id)
    if (t.fresh) void act(thread, { op: 'tab.update', tab: t.id, fresh: false })
  }
  // A fresh tab shown first (the only one left, or picked before) clears its dot too.
  useEffect(() => {
    if (thread && tab?.fresh && !hidden)
      void act(thread, { op: 'tab.update', tab: tab.id, fresh: false })
  }, [thread, tab?.id, tab?.fresh, hidden])

  // The tab in front always shows whole: an agent tab added past the edge, or one picked from the list.
  useEffect(() => {
    if (hidden || !tab) return
    document
      .querySelector(`[data-testid="artifacts-tab-${tab.id}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [tab?.id, hidden, view?.loaded])

  const update = (t: ArtifactTab, patch: { index?: number; hidden?: boolean }): void => {
    if (thread) void act(thread, { op: 'tab.update', tab: t.id, ...patch })
  }

  const actions: RowActions = {
    open: (item) => {
      const to = openTarget(item)
      if (to === null) return
      switch (to.to) {
        case 'browser':
          openLink(to.url)
          return
        case 'files':
          revealTool('files')
          void showPath(to.path, chatStore.getState().panes[PANE_ID]?.file || null)
          return
        case 'testbench':
          requestExperiment(to.experiment)
          openPlace(placeOf('test-bench'))
          return
        case 'canvas':
          openPlace(placeOf('canvas', { canvas: to.slug }))
          return
        case 'subagent':
          openSubagentTab({
            session: chatStore.getState().panes[PANE_ID]?.file || '',
            file: to.file,
            name: to.name,
          })
          return
        case 'lightbox': {
          const list = tab ? tabItems(tab, items, now).filter((i) => i.media !== undefined) : []
          const at = list.findIndex((i) => i.id === item.id)
          setLightbox(at >= 0 ? { list, index: at } : { list: [item], index: 0 })
        }
      }
    },
    external: (url) => void invoke('artifacts.openExternal', { url }),
    pin: (item, pinned) => {
      if (thread) void act(thread, { op: 'pin', id: item.id, pinned })
    },
    menu: (item, x, y) => setItemMenu({ item, x, y }),
  }

  const body = (): ReactNode => {
    if (target === null) {
      return (
        <Empty icon={<IconStack2 size={20} stroke={1.5} />} title="Open a chat or an assistant">
          Artifacts lists what a thread holds: tickets, PRs, links, media and subagents.
        </Empty>
      )
    }
    if (thread === null) {
      return (
        <Empty icon={<IconStack2 size={20} stroke={1.5} />} title="Nothing yet">
          Once this chat starts, what it brings in shows up here.
        </Empty>
      )
    }
    if (!view?.loaded) {
      return up ? (
        <Empty
          icon={<span className="eva-spinner" aria-hidden="true" />}
          title="Loading artifacts"
        />
      ) : (
        <Empty icon={<IconAlertCircle size={20} stroke={1.5} />} title="Relay isn't connected">
          Artifacts come from Relay; they show up once it is back.
        </Empty>
      )
    }
    if (!tab) {
      return (
        <Empty icon={<IconEyeOff size={20} stroke={1.5} />} title="Every tab is hidden">
          Bring one back from the tab list.
        </Empty>
      )
    }
    const props: ViewProps = {
      thread,
      tab,
      items,
      rows: tabItems(tab, items, now),
      byId,
      now,
      actions,
      onOpenMedia: (list, index) => setLightbox({ list, index }),
      onEditRule: setRuling,
    }
    if (tab.id === 'links') return <LinksView key={tab.id} {...props} />
    if (tab.id === 'media') return <MediaView key={tab.id} {...props} placeholder="Search media" />
    if (tab.id === 'subagents') return <SubagentsView key={tab.id} {...props} />
    return <ListView key={tab.id} {...props} />
  }

  return (
    <div
      className="eva-art"
      hidden={hidden}
      data-testid="artifacts-panel"
      data-thread={thread ?? undefined}
    >
      {thread !== null && view?.loaded ? (
        <div className="eva-art-bar">
          <Scroller
            className="eva-art-tabs"
            classNames={{ content: 'eva-art-tabs-content' }}
            edgeGradientColor="var(--eva-c-background)"
            controlSize={28}
            scrollAmount={160}
            startControlIcon={<IconChevronLeft size={14} stroke={1.5} />}
            endControlIcon={<IconChevronRight size={14} stroke={1.5} />}
          >
            <div role="tablist" aria-label="Artifact tabs" className="eva-art-tablist">
              {shownTabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  className="eva-art-tab"
                  aria-selected={t.id === tab?.id}
                  data-active={t.id === tab?.id || undefined}
                  data-testid={`artifacts-tab-${t.id}`}
                  onClick={() => openTab(t)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setTabMenu({ tab: t, x: e.clientX, y: e.clientY })
                  }}
                >
                  <TabMark tab={t} spinning={t.id === 'subagents' && running} />
                  <span>{t.title}</span>
                  {t.fresh ? <span className="eva-art-dot" aria-label="New" /> : null}
                </button>
              ))}
            </div>
          </Scroller>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            className="eva-art-tidy"
            data-testid="artifacts-tidy"
            onClick={() => void tidy()}
          >
            Tidy
          </Button>
          {tidiedCount > 0 ? (
            <Tooltip label={showTidied ? 'Hide tidied items' : 'Show tidied items'} openDelay={400}>
              <ActionIcon
                variant="subtle"
                color="gray"
                className="eva-art-all"
                aria-label="Show tidied"
                aria-pressed={showTidied}
                data-testid="artifacts-show-tidied"
                onClick={() => setShowTidied(thread, !showTidied)}
              >
                {showTidied ? <IconEyeOff {...ICON} /> : <IconEye {...ICON} />}
              </ActionIcon>
            </Tooltip>
          ) : null}
          <EvaMenu opened={allOpen} onChange={setAllOpen} width={240} position="bottom-end">
            <EvaMenu.Target>
              <Tooltip
                label="All tabs, hidden ones too"
                openDelay={400}
                position="bottom-end"
                disabled={allOpen}
              >
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  className="eva-art-all"
                  aria-label="All tabs"
                  data-testid="artifacts-all-tabs"
                >
                  <IconChevronDown {...ICON} />
                </ActionIcon>
              </Tooltip>
            </EvaMenu.Target>
            <EvaMenu.Dropdown data-testid="artifacts-all-menu">
              {tabs.map((t) => (
                <EvaMenu.Item
                  key={t.id}
                  leftSection={<TabMark tab={t} spinning={false} />}
                  rightSection={
                    t.hidden ? (
                      <span className="eva-art-menu-hint">
                        <IconEye size={14} stroke={1.5} /> Show
                      </span>
                    ) : t.id === tab?.id ? (
                      <IconCheck size={14} stroke={1.5} />
                    ) : null
                  }
                  data-hidden={t.hidden || undefined}
                  data-testid={`artifacts-all-${t.id}`}
                  onClick={() => {
                    if (t.hidden) update(t, { hidden: false })
                    openTab(t)
                  }}
                >
                  {t.title}
                </EvaMenu.Item>
              ))}
            </EvaMenu.Dropdown>
          </EvaMenu>
        </div>
      ) : null}
      <div className="eva-art-body">{body()}</div>
      {notice && thread ? (
        <div className="eva-art-notice" data-testid="artifacts-notice">
          {isAgent(notice.by) ? (
            <AgentPortrait id={notice.by} className="eva-art-tab-portrait" />
          ) : null}
          <span className="eva-art-notice-text">
            {`${nameOf(notice.by)} added `}
            <strong>{notice.title}</strong>
          </span>
          <button
            type="button"
            className="eva-art-link"
            data-testid="artifacts-notice-undo"
            onClick={() => {
              dismissNotice(thread, notice.tab)
              void act(thread, { op: 'tab.remove', tab: notice.tab })
            }}
          >
            Undo
          </button>
          <button
            type="button"
            className="eva-art-link eva-art-link-quiet"
            onClick={() => {
              dismissNotice(thread, notice.tab)
              void act(thread, { op: 'tab.update', tab: notice.tab, hidden: true })
            }}
          >
            Hide tab
          </button>
          <Tooltip label="Dismiss" openDelay={400}>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="Dismiss"
              onClick={() => dismissNotice(thread, notice.tab)}
            >
              <IconX size={14} stroke={1.5} />
            </ActionIcon>
          </Tooltip>
        </div>
      ) : null}
      <TabMenu
        menu={tabMenu}
        tabs={tabs}
        now={now}
        onClose={() => setTabMenu(null)}
        onRename={setRenaming}
        onEditRule={setRuling}
        update={update}
      />
      <ItemMenu menu={itemMenu} onClose={() => setItemMenu(null)} />
      <RenameDialog
        tab={renaming}
        onClose={() => setRenaming(null)}
        onSave={async (t, title) =>
          thread ? (await act(thread, { op: 'tab.update', tab: t.id, title })).ok : false
        }
      />
      <RuleDialog
        tab={ruling}
        onClose={() => setRuling(null)}
        onSave={async (t, rule: TabRule) =>
          thread ? (await act(thread, { op: 'tab.update', tab: t.id, rule })).ok : false
        }
      />
      <MediaLightbox
        items={lightbox?.list ?? []}
        start={lightbox?.index ?? null}
        onClose={() => setLightbox(null)}
      />
    </div>
  )
}
