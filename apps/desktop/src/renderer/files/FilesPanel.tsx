import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { ActionIcon, Tooltip } from '@mantine/core'
import {
  IconEye,
  IconEyeOff,
  IconFiles,
  IconFold,
  IconRefresh,
  IconSearch,
  IconTextScan2,
  IconX,
} from '@tabler/icons-react'
import { useChatStore } from '../chat/chat-store'
import { useFrontChatPane } from '../chat/front-chat'
import { EditorArea } from './EditorArea'
import { FileIcon } from './FileIcon'
import { FileTree } from './FileTree'
import {
  clearError,
  collapseAll,
  followChat,
  loadDir,
  refreshGit,
  setQuickOpen,
  setShowIgnored,
  showSide,
  startFiles,
  useFiles,
  useSpace,
} from './files-store'
import { QuickOpen } from './QuickOpen'
import { SearchView } from './SearchView'
import './files.css'

const SIDE_MIN = 160
const SIDE_DEFAULT = 240
/** Below this body width the sidebar floats over the editor and closes once a file opens. */
const NARROW = 620

let sideWidth = SIDE_DEFAULT

function RailButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip label={label} position="right" openDelay={400}>
      <ActionIcon
        variant="subtle"
        color="gray"
        className="eva-files-rail-btn"
        data-active={active || undefined}
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
      >
        {children}
      </ActionIcon>
    </Tooltip>
  )
}

function ExplorerHead({ root }: { root: string }) {
  const name = useSpace((w) => w.name, '')
  const showIgnored = useSpace((w) => w.showIgnored, false)
  return (
    <div className="eva-files-side-head">
      <Tooltip label={root} openDelay={600}>
        <span className="eva-files-root" data-testid="files-root">
          <FileIcon name={name} kind="dir" expanded />
          <span className="eva-files-name">{name}</span>
        </span>
      </Tooltip>
      <Tooltip label={showIgnored ? 'Hide ignored files' : 'Show ignored files'} openDelay={400}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={showIgnored ? 'Hide ignored files' : 'Show ignored files'}
          aria-pressed={showIgnored}
          data-testid="files-toggle-ignored"
          onClick={() => setShowIgnored(root, !showIgnored)}
        >
          {showIgnored ? <IconEye size={14} stroke={1.5} /> : <IconEyeOff size={14} stroke={1.5} />}
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Refresh" openDelay={400}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label="Refresh"
          onClick={() => {
            void loadDir(root, '')
            void refreshGit(root)
          }}
        >
          <IconRefresh size={14} stroke={1.5} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Collapse folders" openDelay={400}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label="Collapse folders"
          onClick={() => collapseAll(root)}
        >
          <IconFold size={14} stroke={1.5} />
        </ActionIcon>
      </Tooltip>
    </div>
  )
}

/**
 * The Files tool: a slim editor over the open chat's worktree (else the Eva root). A rail picks
 * the explorer or search; the editor takes the rest. Quick open floats over both.
 */
export function FilesPanel({ hidden }: { hidden: boolean }) {
  const front = useFrontChatPane()
  const chatFile = useChatStore((s) => s.panes[front]?.file || null)
  const root = useFiles((s) => s.root)
  const side = useFiles((s) => s.side)
  const sideOpen = useFiles((s) => s.sideOpen)
  const quickOpen = useFiles((s) => s.quickOpen)
  const searchFocus = useFiles((s) => s.searchFocus)
  const active = useSpace((w) => w.active, null)
  const error = useSpace((w) => w.error, null)
  const body = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(sideWidth)
  const [narrow, setNarrow] = useState(false)

  useEffect(() => startFiles(), [])
  useEffect(() => {
    if (!hidden) void followChat(chatFile)
  }, [hidden, chatFile])

  useEffect(() => {
    const el = body.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setNarrow((e?.contentRect.width ?? 1000) < NARROW))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // On a narrow panel the floating sidebar steps aside once a file opens.
  const lastActive = useRef(active)
  useEffect(() => {
    if (active !== lastActive.current && active !== null && narrow) showSide(null)
    lastActive.current = active
  }, [active, narrow])

  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const start = width
    const max = (body.current?.clientWidth ?? 800) - 200
    const move = (ev: PointerEvent): void => {
      sideWidth = Math.round(Math.min(Math.max(start + ev.clientX - startX, SIDE_MIN), max))
      setWidth(sideWidth)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const toggle = (view: 'explorer' | 'search'): void =>
    showSide(sideOpen && side === view ? null : view)

  return (
    <div className="eva-files" hidden={hidden} data-testid="files-panel">
      <nav className="eva-files-rail" aria-label="Files views">
        <RailButton
          label="Explorer (⌘⇧E)"
          active={sideOpen && side === 'explorer'}
          onClick={() => toggle('explorer')}
        >
          <IconFiles size={18} stroke={1.5} />
        </RailButton>
        <RailButton
          label="Search in files (⌘⇧F)"
          active={sideOpen && side === 'search'}
          onClick={() => toggle('search')}
        >
          <IconSearch size={18} stroke={1.5} />
        </RailButton>
        <RailButton label="Go to file (⌘P)" onClick={() => setQuickOpen(true)}>
          <IconTextScan2 size={18} stroke={1.5} />
        </RailButton>
      </nav>
      <div className="eva-files-body" ref={body} data-narrow={narrow || undefined}>
        {root && sideOpen ? (
          <aside
            className="eva-files-side"
            style={{ width: narrow ? Math.min(width, 280) : width }}
          >
            {side === 'explorer' ? (
              <>
                <ExplorerHead root={root} />
                <FileTree root={root} />
              </>
            ) : (
              <SearchView root={root} focusKey={searchFocus} />
            )}
            {narrow ? null : (
              <div
                className="eva-files-sash"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize sidebar"
                onPointerDown={onResizeStart}
                onDoubleClick={() => {
                  sideWidth = SIDE_DEFAULT
                  setWidth(SIDE_DEFAULT)
                }}
              />
            )}
          </aside>
        ) : null}
        <main className="eva-files-main">
          {error ? (
            <div className="eva-files-error" role="alert">
              <span>{error}</span>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="Dismiss"
                onClick={() => root && clearError(root)}
              >
                <IconX size={14} stroke={1.5} />
              </ActionIcon>
            </div>
          ) : null}
          {root ? <EditorArea root={root} /> : null}
        </main>
        {root && quickOpen ? <QuickOpen root={root} /> : null}
      </div>
    </div>
  )
}
