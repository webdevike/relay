import type { AgentMark } from './presence-store'
import { monaco } from './monaco-setup'

// Agents in the open buffer: each agent's labeled caret (a content widget at the end of its last
// change) and a highlight on the lines it changed, in its color, fading out with its mark
// (presence-store.ts). Colors are per agent, so their classes are written into one style sheet.

const styled = new Set<string>()
let sheet: HTMLStyleElement | null = null

/** The class suffix for `#rrggbb`, with its rules written once. */
function colorClass(color: string): string {
  const hex = color.slice(1).toLowerCase()
  if (!styled.has(hex)) {
    styled.add(hex)
    sheet ??= document.head.appendChild(document.createElement('style'))
    sheet.append(
      `.eva-agent-line-${hex}{background:#${hex}1f}` +
        `.eva-agent-gutter-${hex}{border-left:3px solid #${hex};margin-left:2px}`,
    )
  }
  return hex
}

function caretWidget(
  id: string,
  mark: AgentMark,
  line: number,
  column: number,
): monaco.editor.IContentWidget {
  const node = document.createElement('div')
  node.className = `eva-agent-caret${mark.fading ? ' is-fading' : ''}${line === 1 ? ' is-below' : ''}`
  node.style.setProperty('--who', mark.agent.color)
  node.dataset.testid = `agent-caret-${mark.agent.name}`
  const label = document.createElement('div')
  label.className = 'eva-agent-label'
  if (mark.agent.avatarUrl) {
    const img = document.createElement('img')
    img.className = 'eva-agent-avatar'
    img.src = mark.agent.avatarUrl
    img.alt = ''
    label.append(img)
  }
  label.append(mark.agent.name)
  if (mark.intent) label.title = mark.intent
  node.append(label)
  return {
    getId: () => id,
    getDomNode: () => node,
    getPosition: () => ({
      position: { lineNumber: line, column },
      preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
    }),
  }
}

/** Draws `marks` in `editor`'s model; returns the undo. */
export function drawAgentMarks(
  editor: monaco.editor.IStandaloneCodeEditor,
  marks: readonly AgentMark[],
): () => void {
  const model = editor.getModel()
  if (!model || marks.length === 0) return () => undefined
  const lines = model.getLineCount()
  const clampLine = (n: number): number => Math.min(Math.max(1, n), lines)
  const decorations: monaco.editor.IModelDeltaDecoration[] = []
  const widgets: monaco.editor.IContentWidget[] = []
  for (const mark of marks) {
    const hex = colorClass(mark.agent.color)
    const fade = mark.fading ? ' is-fading' : ''
    for (const r of mark.ranges) {
      decorations.push({
        range: new monaco.Range(clampLine(r.startLine), 1, clampLine(r.endLine), 1),
        options: {
          isWholeLine: true,
          className: `eva-agent-line eva-agent-line-${hex}${fade}`,
          linesDecorationsClassName: `eva-agent-gutter eva-agent-gutter-${hex}${fade}`,
          overviewRuler: {
            color: mark.agent.color,
            position: monaco.editor.OverviewRulerLane.Right,
          },
        },
      })
    }
    const line = clampLine(mark.caret.line)
    const column = Math.min(Math.max(1, mark.caret.column), model.getLineMaxColumn(line))
    widgets.push(caretWidget(`eva-agent-caret-${hex}-${mark.seq}`, mark, line, column))
  }
  const collection = editor.createDecorationsCollection(decorations)
  for (const w of widgets) editor.addContentWidget(w)
  return () => {
    collection.clear()
    for (const w of widgets) editor.removeContentWidget(w)
  }
}
