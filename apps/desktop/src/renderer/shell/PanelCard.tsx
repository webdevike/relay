import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ActionIcon, Tooltip } from '@mantine/core'
import { IconFiles, IconFlask, IconGlobe, IconLayoutSidebarRight } from '@tabler/icons-react'
import { BrowserPanel } from '../browser/BrowserPanel'
import { useChatStore } from '../chat/chat-store'
import { PANE_ID } from '../chat/open-chat'
import { SubagentTranscript } from '../chat/SubagentTranscript'
import { SubagentStateIcon, subagentState } from '../chat/strips/SubagentChips'
import { setPanelFocused } from '../hotkeys/panel-focus'
import { ExperimentArmPanel } from '../test-bench/ExperimentArmPanel'
import { useFilesHotkeys } from '../files/files-hotkeys'
import { Grip } from './Grip'
import {
  settlePanelView,
  showPanelTool,
  togglePanel,
  useLayout,
  type PanelTool,
  type SubagentView,
} from './layout-store'

// The files editor (and Monaco behind it) loads the first time Files opens.
const FilesPanel = lazy(() =>
  import('../files/FilesPanel').then((m) => ({ default: m.FilesPanel })),
)

const TOOLS: Array<{ tool: PanelTool; label: string; Icon: typeof IconGlobe }> = [
  { tool: 'browser', label: 'Browser', Icon: IconGlobe },
  { tool: 'files', label: 'Files', Icon: IconFiles },
]

/** The current panel slide duration in ms; 0 when motion is off. */
function slideMs(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--eva-dur-slide').trim()
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return 0
  return raw.endsWith('ms') ? n : n * 1000
}

/** The open chat's live entry for the viewed subagent, while that chat is still the one shown. */
function useViewedSubagent(view: SubagentView | null) {
  return useChatStore((s) => {
    if (view === null) return undefined
    const pane = s.panes[PANE_ID]
    if (!pane || pane.file !== view.session) return undefined
    return pane.extras.subagents.find((a) => a.name === view.name)
  })
}

/**
 * The panel stays mounted when closed; display none sizes the browser slot to 0 so the native
 * view hides. A close keeps it shown for one slide so the width can animate to 0. The card keeps
 * its width while the wrap narrows, so the page slides out past the window edge unclipped.
 * A subagent's transcript or an experiment arm's details replace the tool in front (the browser
 * or Files), which stays mounted but hidden (the browser slot sizes to 0 the same way); once a
 * close finished sliding, the panel is that tool again. Files mounts the first time it shows.
 */
export function PanelCard() {
  const open = useLayout((s) => s.panelPx > 0)
  const view = useLayout((s) => s.panelView)
  const subagentView = view.kind === 'subagent' ? view : null
  const subagent = useViewedSubagent(subagentView)
  const [shown, setShown] = useState(open)
  const [filesMounted, setFilesMounted] = useState(false)
  if (view.kind === 'files' && !filesMounted) setFilesMounted(true)
  useFilesHotkeys()
  const previous = useRef(open)

  useEffect(() => {
    if (previous.current === open) return
    previous.current = open
    if (open) {
      setShown(true)
      return
    }
    const ms = slideMs()
    if (!ms) {
      setShown(false)
      return
    }
    const timer = window.setTimeout(() => setShown(false), ms)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!shown) settlePanelView()
  }, [shown])

  return (
    <div
      className="eva-panel-wrap"
      data-open={shown ? 'true' : 'false'}
      data-closing={shown && !open ? 'true' : undefined}
    >
      {open ? <Grip edge="panel" /> : null}
      <div className="eva-panel-clip">
        <section
          className="eva-card eva-panel-card"
          data-testid="panel-card"
          onFocusCapture={() => setPanelFocused(true)}
          onBlurCapture={() => setPanelFocused(false)}
        >
          <header className="eva-panel-header" data-testid="panel-header">
            {subagentView ? (
              <span className="eva-panel-tool" data-testid="panel-subagent-title">
                {subagent ? <SubagentStateIcon state={subagentState(subagent)} /> : null}
                <span className="eva-panel-tool-name">{subagentView.name}</span>
              </span>
            ) : view.kind === 'experiment-arm' ? (
              <span className="eva-panel-tool" data-testid="panel-experiment-title">
                <IconFlask size={16} stroke={1.5} />
                <span className="eva-panel-tool-name">{view.label}</span>
              </span>
            ) : (
              <div className="eva-panel-tools" role="tablist" aria-label="Panel tools">
                {TOOLS.map(({ tool, label, Icon }) => (
                  <button
                    key={tool}
                    type="button"
                    role="tab"
                    aria-selected={view.kind === tool}
                    className="eva-panel-tool-tab"
                    data-active={view.kind === tool || undefined}
                    data-testid={`panel-tab-${tool}`}
                    onClick={() => showPanelTool(tool)}
                  >
                    <Icon size={16} stroke={1.5} />
                    {label}
                  </button>
                ))}
              </div>
            )}
            <Tooltip label="Close panel (⌘⇧B)" position="bottom-end" openDelay={400}>
              <ActionIcon
                variant="subtle"
                className="eva-header-btn"
                aria-label="Close panel"
                data-testid="panel-close"
                onClick={() => togglePanel()}
              >
                <IconLayoutSidebarRight size={16} stroke={1.5} />
              </ActionIcon>
            </Tooltip>
          </header>
          <BrowserPanel hidden={view.kind !== 'browser'} />
          {subagentView ? (
            <SubagentTranscript file={subagentView.file} version={subagent?.mtimeMs ?? null} />
          ) : null}
          {filesMounted ? (
            <Suspense fallback={null}>
              <FilesPanel hidden={view.kind !== 'files'} />
            </Suspense>
          ) : null}
          {view.kind === 'experiment-arm' ? (
            <ExperimentArmPanel key={`${view.experiment}/${view.arm}`} view={view} />
          ) : null}
        </section>
      </div>
    </div>
  )
}
