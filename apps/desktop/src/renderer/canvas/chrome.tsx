/** The board's floating chrome: the tool bar, the zoom and history controls and the card toolbar. */
import { ActionIcon, Tooltip } from '@mantine/core'
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconCopy,
  IconFocusCentered,
  IconHandStop,
  IconHighlight,
  IconLock,
  IconLockOpen,
  IconMessageCirclePlus,
  IconMessagePlus,
  IconMinus,
  IconNote,
  IconPlus,
  IconPointer,
  IconTrash,
  type Icon,
} from '@tabler/icons-react'
import { NodeToolbar, Panel, Position, useReactFlow } from '@xyflow/react'
import { FIT_PADDING } from './board-model'

export type Tool = 'select' | 'hand'

function ChromeButton({
  icon: Glyph,
  label,
  keys,
  testid,
  onClick,
  active,
  disabled,
  placement = 'bottom',
}: {
  icon: Icon
  label: string
  /** The key that does the same: shown in the tooltip ("Comment (press /)") and announced. */
  keys?: string
  testid: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
  placement?: 'bottom' | 'right' | 'top'
}) {
  return (
    <Tooltip
      label={keys === undefined ? label : `${label} (press ${keys})`}
      position={placement}
      openDelay={400}
    >
      <ActionIcon
        variant="subtle"
        color="gray"
        className="eva-cv-chrome-btn"
        data-active={active ? 'true' : undefined}
        aria-pressed={active}
        aria-label={label}
        aria-keyshortcuts={keys}
        data-testid={testid}
        disabled={disabled}
        onClick={onClick}
      >
        <Glyph size={16} stroke={1.5} />
      </ActionIcon>
    </Tooltip>
  )
}

/** Select or Hand (every drag pans), a rule, then Add a note and Comment. */
export function ToolBar({
  tool,
  onTool,
  onAddNote,
  onComment,
  disabled,
  canComment,
}: {
  tool: Tool
  onTool: (tool: Tool) => void
  onAddNote: () => void
  onComment: () => void
  disabled: boolean
  canComment: boolean
}) {
  return (
    <Panel position="top-center" className="eva-cv-chrome eva-cv-tools" data-testid="canvas-tools">
      <ChromeButton
        icon={IconPointer}
        label="Select"
        testid="canvas-tool-select"
        active={tool === 'select'}
        onClick={() => onTool('select')}
      />
      <ChromeButton
        icon={IconHandStop}
        label="Hand: drag to pan"
        testid="canvas-tool-hand"
        active={tool === 'hand'}
        onClick={() => onTool('hand')}
      />
      <span className="eva-cv-rule" aria-hidden />
      <ChromeButton
        icon={IconNote}
        label="Add a note"
        testid="canvas-tool-note"
        disabled={disabled}
        onClick={() => {
          onTool('select')
          onAddNote()
        }}
      />
      <ChromeButton
        icon={IconMessageCirclePlus}
        label="Comment"
        keys="/"
        testid="canvas-tool-comment"
        disabled={!canComment}
        onClick={onComment}
      />
    </Panel>
  )
}

/** Zoom in, zoom out, fit, lock, then undo and redo. */
export function BoardControls({
  locked,
  onLock,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  locked: boolean
  onLock: () => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
}) {
  const flow = useReactFlow()
  return (
    <Panel
      position="bottom-left"
      className="eva-cv-chrome eva-cv-controls"
      data-testid="canvas-controls"
    >
      <ChromeButton
        icon={IconPlus}
        label="Zoom in"
        testid="canvas-zoom-in"
        placement="right"
        onClick={() => void flow.zoomIn()}
      />
      <ChromeButton
        icon={IconMinus}
        label="Zoom out"
        testid="canvas-zoom-out"
        placement="right"
        onClick={() => void flow.zoomOut()}
      />
      <ChromeButton
        icon={IconFocusCentered}
        label="Fit view"
        testid="canvas-fit"
        placement="right"
        onClick={() => void flow.fitView({ padding: FIT_PADDING })}
      />
      <ChromeButton
        icon={locked ? IconLock : IconLockOpen}
        label={locked ? 'Unlock the board' : 'Lock the board'}
        testid="canvas-lock"
        placement="right"
        active={locked}
        onClick={onLock}
      />
      <span className="eva-cv-rule" aria-hidden />
      <ChromeButton
        icon={IconArrowBackUp}
        label="Undo"
        testid="canvas-undo"
        placement="right"
        disabled={!canUndo}
        onClick={onUndo}
      />
      <ChromeButton
        icon={IconArrowForwardUp}
        label="Redo"
        testid="canvas-redo"
        placement="right"
        disabled={!canRedo}
        onClick={onRedo}
      />
    </Panel>
  )
}

/** The selected card's toolbar: copy its title, highlight its links, add a linked note, delete. */
export function NodeActions({
  nodeId,
  onCopy,
  onHighlight,
  onAddNote,
  onDelete,
}: {
  nodeId: string
  onCopy: () => void
  onHighlight: () => void
  onAddNote: () => void
  onDelete: () => void
}) {
  return (
    <NodeToolbar nodeId={nodeId} isVisible position={Position.Top} offset={10}>
      <div className="eva-cv-chrome eva-cv-node-tools" data-testid="canvas-node-toolbar">
        <ChromeButton
          icon={IconCopy}
          label="Copy title"
          testid="canvas-node-copy"
          onClick={onCopy}
        />
        <ChromeButton
          icon={IconHighlight}
          label="Highlight links"
          testid="canvas-node-highlight"
          onClick={onHighlight}
        />
        <ChromeButton
          icon={IconMessagePlus}
          label="Add a linked note"
          testid="canvas-node-note"
          onClick={onAddNote}
        />
        <ChromeButton
          icon={IconTrash}
          label="Delete"
          testid="canvas-node-delete"
          onClick={onDelete}
        />
      </div>
    </NodeToolbar>
  )
}
