import { useEffect, useReducer, type RefObject } from 'react'
import { ActionIcon, CloseButton, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconMessagePlus } from '@tabler/icons-react'
import { FILE_NOTE_CODE_MAX, lineSpan } from '@evaos/contract'
import type { Mentionable } from '@relay/canvas-live/mentions'
import { Composer } from '../comments/ThreadParts'
import { invoke } from '../ipc'
import { frontWorkspace } from '../tiling/tiling-store'
import { nameOf } from './tree-model'
import { monaco } from './monaco-setup'

// Comment on code in Files: select lines, then Comment (the editor's context menu, or the small
// button that floats at the end of the selection), write a note and send it. It goes to the chat
// that owns the workspace as a background message (`agent.note`, surface `files`), like a comment
// on a board or a page: the file, the lines, the code and a link back to them.

/** The lines a comment is on, frozen when Comment was picked. */
export interface CodeDraft {
  root: string
  /** Relative to `root`. */
  path: string
  start: number
  end: number
  code: string
  language: string
}

const BUTTON = 24
const CARD_WIDTH = 340
const GAP = 6
const NO_MENTIONS: readonly Mentionable[] = []

/**
 * What the editor's selection comments on: whole lines from its first to its last, where a
 * selection that ends at the start of a line stops on the line above. Null when nothing is selected.
 */
export function draftOf(
  editor: monaco.editor.IStandaloneCodeEditor,
  key: string | null,
): CodeDraft | null {
  const model = editor.getModel()
  const sel = editor.getSelection()
  if (key === null || !model || !sel || sel.isEmpty()) return null
  const [root, path] = key.split('\0') as [string, string]
  const start = sel.startLineNumber
  const end =
    sel.endColumn === 1 && sel.endLineNumber > start ? sel.endLineNumber - 1 : sel.endLineNumber
  return {
    root,
    path,
    start,
    end,
    code: model.getValueInRange(sel).slice(0, FILE_NOTE_CODE_MAX),
    language: model.getLanguageId(),
  }
}

/** Sends the note to the chat that owns the front workspace; throws what to show when it can't. */
async function send(draft: CodeDraft, text: string): Promise<string | null> {
  const r = await invoke('agent.note', {
    note: {
      surface: 'files',
      text: text.slice(0, 4000),
      path: `${draft.root.replace(/\/+$/, '')}/${draft.path}`,
      rel: draft.path,
      start: draft.start,
      end: draft.end,
      code: draft.code,
      ...(draft.language && draft.language !== 'plaintext' ? { language: draft.language } : {}),
    },
    workspace: frontWorkspace() || null,
  })
  if (!r.ok) throw new Error(r.error.message)
  if (!r.value.sent) throw new Error('Not sent: no chat owns this workspace')
  return r.value.to
}

/** Re-renders on every scroll, layout and selection change of `editor`. */
function useEditorTick(editor: monaco.editor.IStandaloneCodeEditor | null): void {
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (!editor) return
    const subs = [
      editor.onDidScrollChange(tick),
      editor.onDidLayoutChange(tick),
      editor.onDidChangeCursorSelection(tick),
      editor.onDidChangeModel(tick),
      editor.onDidChangeModelContent(tick),
    ]
    return () => subs.forEach((s) => s.dispose())
  }, [editor])
}

/** Where line `line` ends on screen, in the editor's own px; null when it is scrolled away. */
function lineEnd(
  editor: monaco.editor.IStandaloneCodeEditor,
  line: number,
): { top: number; left: number; height: number } | null {
  const model = editor.getModel()
  if (!model || line > model.getLineCount()) return null
  const at = editor.getScrolledVisiblePosition({
    lineNumber: line,
    column: model.getLineMaxColumn(line),
  })
  const box = editor.getLayoutInfo()
  if (!at || at.top + at.height < 0 || at.top > box.height) return null
  return at
}

/**
 * The Comment button by the selection and, once picked, the note card under the lines. Drawn over
 * the editor (outside Monaco's DOM, so its keys stay out of the editor's keybindings).
 */
export function CodeComment({
  editor,
  current,
  draft,
  onDraft,
}: {
  editor: monaco.editor.IStandaloneCodeEditor | null
  /** The open buffer's key (`root\0path`). */
  current: RefObject<string | null>
  draft: CodeDraft | null
  onDraft: (draft: CodeDraft | null) => void
}) {
  useEditorTick(editor)
  // The commented lines stay tinted while the card is open (the field has the focus, not the editor).
  useEffect(() => {
    if (!editor || !draft) return
    const lines = editor.createDecorationsCollection([
      {
        range: new monaco.Range(draft.start, 1, draft.end, 1),
        options: { isWholeLine: true, className: 'eva-code-comment-lines' },
      },
    ])
    return () => lines.clear()
  }, [editor, draft])

  if (!editor) return null
  const box = editor.getLayoutInfo()
  const close = (): void => {
    onDraft(null)
    editor.focus()
  }

  if (draft) {
    if (current.current !== `${draft.root}\0${draft.path}`) return null
    const below = lineEnd(editor, draft.end)
    const startAt = editor.getScrolledVisiblePosition({ lineNumber: draft.start, column: 1 })
    const left = Math.max(
      GAP,
      Math.min((startAt?.left ?? box.contentLeft) - GAP, box.width - CARD_WIDTH - GAP * 3),
    )
    // Under the last line; above the first when the lines run to the bottom of the editor.
    const roomBelow = below !== null && below.top + below.height + 140 < box.height
    const top = roomBelow
      ? below.top + below.height + GAP
      : Math.max(GAP, (startAt?.top ?? GAP) - GAP)
    const name = `${nameOf(draft.path)}, ${lineSpan(draft.start, draft.end)}`
    return (
      <div
        className="eva-code-comment"
        data-testid="files-comment-card"
        data-above={roomBelow ? undefined : 'true'}
        style={{ top, left, width: CARD_WIDTH }}
        onKeyDownCapture={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          e.stopPropagation()
          close()
        }}
      >
        <div className="eva-code-comment-head">
          <span className="eva-code-comment-title" title={draft.path}>
            Comment on {name}
          </span>
          <CloseButton size="sm" aria-label="Close" onClick={close} />
        </div>
        <Composer
          label="Comment"
          placeholder="Add a note for the chat..."
          testid="files-comment"
          mentionables={NO_MENTIONS}
          send={async (text) => {
            const to = await send(draft, text)
            onDraft(null)
            editor.focus()
            notifications.show({ message: to ? `Comment sent to ${to}` : 'Comment sent' })
          }}
        />
      </div>
    )
  }

  const pick = draftOf(editor, current.current)
  if (!pick) return null
  const at = lineEnd(editor, pick.end)
  if (!at) return null
  return (
    <Tooltip label="Comment" openDelay={300}>
      <ActionIcon
        className="eva-code-comment-button"
        data-testid="files-comment-button"
        aria-label="Comment on the selected lines"
        size={BUTTON}
        radius="xl"
        variant="filled"
        style={{
          top: at.top + (at.height - BUTTON) / 2,
          left: Math.min(at.left + GAP * 2, box.width - box.verticalScrollbarWidth - BUTTON - GAP),
        }}
        // The editor keeps its selection while the button is pressed.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onDraft(draftOf(editor, current.current))}
      >
        <IconMessagePlus size={14} stroke={1.75} />
      </ActionIcon>
    </Tooltip>
  )
}
