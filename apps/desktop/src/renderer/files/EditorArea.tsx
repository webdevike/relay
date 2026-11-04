import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { ActionIcon, Button, Tooltip } from '@mantine/core'
import {
  IconAlertTriangle,
  IconCode,
  IconCopy,
  IconDots,
  IconEye,
  IconFileOff,
  IconFolderOpen,
  IconInfoCircle,
  IconRefresh,
  IconX,
} from '@tabler/icons-react'
import { EvaMenu, EvaModal } from '../overlay'
import { Markdown } from '../chat/markdown/Markdown'
import { FileIcon } from './FileIcon'
import {
  activateTab,
  agentFileKey,
  closeTab,
  pinTab,
  reloadTab,
  requestCloseTab,
  revealFinder,
  saveTab,
  setClosingPath,
  useFiles,
  useSpace,
  type EditorTab,
} from './files-store'
import { nameOf, parentOf } from './tree-model'

// Monaco is large; it loads the first time a text file opens.
const CodeEditor = lazy(() => import('./CodeEditor').then((m) => ({ default: m.CodeEditor })))

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function Tab({
  root,
  tab,
  active,
  hint,
  onClose,
}: {
  root: string
  tab: EditorTab
  active: boolean
  hint: string | null
  onClose: () => void
}) {
  const name = nameOf(tab.path)
  return (
    <div
      role="tab"
      aria-selected={active}
      className="eva-files-tab"
      data-active={active || undefined}
      data-preview={!tab.pinned || undefined}
      data-dirty={tab.dirty || undefined}
      data-testid="files-tab"
      title={tab.path}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          onClose()
        } else if (e.button === 0) activateTab(root, tab.path)
      }}
      onDoubleClick={() => pinTab(root, tab.path)}
    >
      <FileIcon name={name} kind="file" size={14} />
      <span className="eva-files-tab-name">{name}</span>
      {hint ? <span className="eva-files-tab-hint">{hint}</span> : null}
      <button
        type="button"
        className="eva-files-tab-close"
        aria-label={tab.dirty ? `Close ${name} (unsaved)` : `Close ${name}`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={onClose}
      >
        <span className="eva-files-tab-dot" />
        <IconX size={12} stroke={2} />
      </button>
    </div>
  )
}

function Notice({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="eva-files-notice" data-testid="files-notice">
      {icon}
      <div>{children}</div>
    </div>
  )
}

function Body({ root, tab, preview }: { root: string; tab: EditorTab; preview: boolean }) {
  if (tab.error) return <Notice icon={<IconFileOff size={20} stroke={1.5} />}>{tab.error}</Notice>
  const c = tab.content
  if (c === null) return <div className="eva-files-monaco" />
  if (c.kind === 'text') {
    if (preview)
      return (
        <div className="eva-files-md">
          <Markdown text={c.text} />
        </div>
      )
    return (
      <Suspense fallback={<div className="eva-files-monaco" />}>
        <CodeEditor root={root} tab={{ ...tab, content: c }} />
      </Suspense>
    )
  }
  if (c.kind === 'image')
    return (
      <div className="eva-files-image" data-testid="files-image">
        <img src={c.dataUrl} alt={nameOf(tab.path)} />
        <span>{formatSize(c.size)}</span>
      </div>
    )
  const reveal = (
    <Button
      variant="default"
      size="xs"
      leftSection={<IconFolderOpen size={14} stroke={1.5} />}
      onClick={() => revealFinder(root, tab.path)}
    >
      Show in Finder
    </Button>
  )
  return (
    <Notice icon={<IconFileOff size={20} stroke={1.5} />}>
      <p>
        {c.kind === 'binary'
          ? `Binary file (${formatSize(c.size)}), not shown.`
          : `Too large to open here (${formatSize(c.size)}).`}
      </p>
      {reveal}
    </Notice>
  )
}

const NO_TABS: EditorTab[] = []

/** Open files as tabs over one editor, with the banners and notices around it. */
export function EditorArea({ root }: { root: string }) {
  const tabs = useSpace((w) => w.tabs, NO_TABS)
  const active = useSpace((w) => w.active, null)
  const closing = useSpace((w) => w.closing, null)
  const [menu, setMenu] = useState(false)
  const setClosing = (path: string | null): void => setClosingPath(root, path)
  const [previews, setPreviews] = useState<ReadonlySet<string>>(new Set())
  const tab = tabs.find((t) => t.path === active) ?? null
  const note = useFiles((s) => (tab ? s.agentFiles[agentFileKey(root, tab.path)] : undefined))
  const strip = useRef<HTMLDivElement>(null)
  useEffect(() => {
    strip.current
      ?.querySelector('[data-active]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active, tabs.length])

  const names = new Map<string, number>()
  for (const t of tabs) names.set(nameOf(t.path), (names.get(nameOf(t.path)) ?? 0) + 1)

  const requestClose = (t: EditorTab): void => requestCloseTab(root, t.path)
  const closingTab = tabs.find((t) => t.path === closing) ?? null
  const isMarkdown = tab !== null && /\.(md|mdx|markdown)$/i.test(tab.path)
  const previewing = tab !== null && isMarkdown && previews.has(tab.path)

  if (tabs.length === 0)
    return (
      <div className="eva-files-welcome" data-testid="files-welcome">
        <p>Open a file from the tree, or press ⌘P to find one by name.</p>
        <p>⌘⇧F searches inside files.</p>
      </div>
    )

  return (
    <div className="eva-files-editor">
      <div className="eva-files-tabs" role="tablist" aria-label="Open files">
        <div className="eva-files-tabs-scroll" ref={strip}>
          {tabs.map((t) => (
            <Tab
              key={t.path}
              root={root}
              tab={t}
              active={t.path === active}
              hint={(names.get(nameOf(t.path)) ?? 0) > 1 ? nameOf(parentOf(t.path)) || './' : null}
              onClose={() => requestClose(t)}
            />
          ))}
        </div>
        {tab ? (
          <div className="eva-files-tabs-actions">
            {isMarkdown ? (
              <Tooltip label={previewing ? 'Show source' : 'Preview'} openDelay={400}>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label={previewing ? 'Show source' : 'Preview'}
                  onClick={() =>
                    setPreviews((p) => {
                      const next = new Set(p)
                      if (previewing) next.delete(tab.path)
                      else next.add(tab.path)
                      return next
                    })
                  }
                >
                  {previewing ? (
                    <IconCode size={16} stroke={1.5} />
                  ) : (
                    <IconEye size={16} stroke={1.5} />
                  )}
                </ActionIcon>
              </Tooltip>
            ) : null}
            <EvaMenu opened={menu} onChange={setMenu} position="bottom-end" testid="files-tab-menu">
              <EvaMenu.Target>
                <ActionIcon variant="subtle" color="gray" aria-label="File actions">
                  <IconDots size={16} stroke={1.5} />
                </ActionIcon>
              </EvaMenu.Target>
              <EvaMenu.Dropdown>
                <EvaMenu.Item
                  leftSection={<IconCopy size={14} stroke={1.5} />}
                  onClick={() => void navigator.clipboard.writeText(`${root}/${tab.path}`)}
                >
                  Copy path
                </EvaMenu.Item>
                <EvaMenu.Item
                  leftSection={<IconCopy size={14} stroke={1.5} />}
                  onClick={() => void navigator.clipboard.writeText(tab.path)}
                >
                  Copy relative path
                </EvaMenu.Item>
                {note?.remote ? null : (
                  <EvaMenu.Item
                    leftSection={<IconFolderOpen size={14} stroke={1.5} />}
                    onClick={() => revealFinder(root, tab.path)}
                  >
                    Show in Finder
                  </EvaMenu.Item>
                )}
                <EvaMenu.Item
                  leftSection={<IconRefresh size={14} stroke={1.5} />}
                  onClick={() => void reloadTab(root, tab.path)}
                >
                  Reload from disk
                </EvaMenu.Item>
              </EvaMenu.Dropdown>
            </EvaMenu>
          </div>
        ) : null}
      </div>
      {tab?.conflict ? (
        <div className="eva-files-banner" role="alert" data-testid="files-conflict">
          <IconAlertTriangle size={16} stroke={1.5} />
          <span>This file changed on disk. Your edits are kept.</span>
          <Button
            size="compact-xs"
            variant="default"
            onClick={() => void reloadTab(root, tab.path)}
          >
            Load disk version
          </Button>
          <Button
            size="compact-xs"
            variant="default"
            onClick={() => void saveTab(root, tab.path, true)}
          >
            Overwrite
          </Button>
        </div>
      ) : null}
      {note?.kind === 'prime' ? (
        <div className="eva-files-banner" data-tone="info" data-testid="files-prime-note">
          <IconInfoCircle size={16} stroke={1.5} />
          <span>
            Changes apply when {note.title} starts fresh; tell {note.title} to reload now.
          </span>
        </div>
      ) : null}
      {tab ? <Body root={root} tab={tab} preview={previewing} /> : null}
      <EvaModal
        opened={closingTab !== null}
        onClose={() => setClosing(null)}
        title={closingTab ? `Save changes to ${nameOf(closingTab.path)}?` : undefined}
        testid="files-close-dirty"
      >
        <p className="eva-files-modal-text">Your changes are lost if you close without saving.</p>
        <div className="eva-files-modal-actions">
          <Button variant="default" onClick={() => setClosing(null)}>
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={() => {
              if (closingTab) closeTab(root, closingTab.path)
              setClosing(null)
            }}
          >
            Close without saving
          </Button>
          <Button
            onClick={async () => {
              if (!closingTab) return
              const r = await saveTab(root, closingTab.path, false)
              if (r === 'saved') closeTab(root, closingTab.path)
              setClosing(null)
            }}
          >
            Save
          </Button>
        </div>
      </EvaModal>
    </div>
  )
}
