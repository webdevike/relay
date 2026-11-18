import { monaco } from '../monaco-setup'
import type { AgentMark } from '../presence-store'
import {
  layoutMarkdown,
  type Block,
  type LineKind,
  type MdLayout,
  type SpanKind,
} from './md-layout'

// A Markdown file drawn rendered in the Files editor, on the same Monaco model the source view
// edits: headings, emphasis, links, code, quotes, lists and task boxes are decorations over the
// text; the Markdown syntax around them hides unless the caret is in it; tables, standalone
// images and frontmatter show as their rendered form (a view zone over their hidden lines) until
// Isaac clicks into one. Nothing rewrites the text, so undo, dirty state, save, disk merges and
// agents' edits are the model's own, and a file saves byte for byte as typed.

type Editor = monaco.editor.IStandaloneCodeEditor
type Decoration = monaco.editor.IModelDeltaDecoration

/** A rendered block's slot: the zone element its rendered form portals into. */
export interface BlockSlot {
  key: string
  block: Block
  el: HTMLElement
  /** Agents whose latest edit touched the block's lines. */
  agents: AgentMark[]
  /** Puts the caret in the block, which shows its lines for editing. */
  open(): void
}

export interface LivePreviewOptions {
  /** The rendered blocks changed (React portals into their elements). */
  onBlocks(slots: BlockSlot[]): void
  /** Cmd+click on a link. */
  openLink(url: string): void
}

export interface LivePreview {
  setAgents(marks: readonly AgentMark[]): void
  dispose(): void
}

/** The prose column, at most this wide (px); the rest is margin on both sides. */
const MEASURE = 720
const MIN_SIDE = 24
const HIDDEN_SOURCE = 'eva-md-blocks'

/** Prose settings over the code editor's: the editor is created with them (CodeEditor). */
export const PROSE_OPTIONS: monaco.editor.IEditorOptions = {
  lineNumbers: 'off',
  glyphMargin: false,
  folding: false,
  wordWrap: 'wordWrapColumn',
  wrappingStrategy: 'advanced',
  wrappingIndent: 'same',
  fontSize: 15,
  lineHeight: 24,
  fontLigatures: true,
  renderLineHighlight: 'none',
  occurrencesHighlight: 'off',
  selectionHighlight: false,
  matchBrackets: 'never',
  guides: { indentation: false, bracketPairs: false },
  stickyScroll: { enabled: false },
  bracketPairColorization: { enabled: false },
  quickSuggestions: false,
  suggestOnTriggerCharacters: false,
  unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
  renderWhitespace: 'none',
  links: false,
  colorDecorators: false,
  cursorWidth: 2,
  padding: { top: 28, bottom: 56 },
  overviewRulerLanes: 0,
  allowVariableLineHeights: true,
  allowVariableFonts: true,
}

// Monaco measures font decorations (`fontSize`, `fontWeight`...) but draws them only through CSS:
// each one's class in files.css sets the same font.
const HEADING: Record<string, { size: number; lineHeight: number }> = {
  h1: { size: 26, lineHeight: 1.75 },
  h2: { size: 21, lineHeight: 1.5 },
  h3: { size: 18, lineHeight: 1.33 },
  h4: { size: 16, lineHeight: 1.17 },
  h5: { size: 15, lineHeight: 1 },
  h6: { size: 14, lineHeight: 1 },
}

const SPAN: Record<SpanKind, monaco.editor.IModelDecorationOptions> = {
  strong: { inlineClassName: 'eva-md-strong', fontWeight: '650' },
  em: { inlineClassName: 'eva-md-em', fontStyle: 'italic' },
  del: { inlineClassName: 'eva-md-del' },
  code: { inlineClassName: 'eva-md-code', fontFamily: 'var(--eva-font-code)', fontSize: '13px' },
  link: { inlineClassName: 'eva-md-link' },
  'syntax-dim': { inlineClassName: 'eva-md-syntax' },
}

const LINE_CLASS: Partial<Record<LineKind, string>> = {
  code: 'eva-md-code-line',
  fence: 'eva-md-code-line eva-md-fence',
  hr: 'eva-md-hr',
  html: 'eva-md-code-line',
}

/** `[start, end]` overlaps any selection (offsets, inclusive at both ends). */
function touches(sel: ReadonlyArray<[number, number]>, start: number, end: number): boolean {
  return sel.some(([a, b]) => start <= b && a <= end)
}

function rangeOf(model: monaco.editor.ITextModel, start: number, end: number): monaco.Range {
  return monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(end))
}

/** The decorations for `layout` with the caret's syntax showing (`sel`: selections as offsets, or none). */
export function previewDecorations(
  model: monaco.editor.ITextModel,
  layout: MdLayout,
  sel: ReadonlyArray<[number, number]>,
): Decoration[] {
  const out: Decoration[] = []
  for (const [line, kinds] of layout.lines) {
    if (line > model.getLineCount()) continue
    const full = new monaco.Range(line, 1, line, model.getLineMaxColumn(line))
    for (const k of kinds) {
      const heading = HEADING[k]
      if (heading)
        out.push({
          range: full,
          options: {
            fontSize: `${heading.size}px`,
            lineHeight: heading.lineHeight,
            fontWeight: '650',
            inlineClassName: `eva-md-heading eva-md-${k}`,
          },
        })
      else if (k === 'code' || k === 'fence' || k === 'html') {
        // The gutter piece pads the block on the left, where the text starts at the column edge.
        out.push({
          range: full,
          options: {
            isWholeLine: true,
            className: LINE_CLASS[k],
            linesDecorationsClassName: 'eva-md-code-gutter',
          },
        })
        out.push({
          range: full,
          options: {
            fontFamily: 'var(--eva-font-code)',
            fontSize: '13px',
            inlineClassName: k === 'fence' ? 'eva-md-fence-label' : 'eva-md-code-text',
          },
        })
      } else if (k === 'quote') {
        out.push({
          range: full,
          options: {
            linesDecorationsClassName: 'eva-md-quote-bar',
            inlineClassName: 'eva-md-quote',
          },
        })
      } else if (k === 'hr') {
        out.push({ range: full, options: { isWholeLine: true, className: LINE_CLASS.hr } })
      } else if (k === 'task-done') {
        out.push({ range: full, options: { inlineClassName: 'eva-md-done' } })
      }
    }
  }
  for (const s of layout.spans)
    out.push({ range: rangeOf(model, s.start, s.end), options: SPAN[s.kind] })
  for (const l of layout.links)
    out.push({
      range: rangeOf(model, l.start, l.end),
      options: { hoverMessage: { value: `${l.url}  \nCmd+click to open` } },
    })
  for (const at of layout.bullets)
    out.push({ range: rangeOf(model, at, at + 1), options: { inlineClassName: 'eva-md-bullet' } })
  for (const t of layout.tasks)
    out.push({
      range: rangeOf(model, t.start, t.start + 3),
      options: { inlineClassName: `eva-md-task${t.checked ? ' is-checked' : ''}` },
    })
  for (const s of layout.syntax) {
    const shown = touches(sel, s.scope.start, s.scope.end)
    out.push({
      range: rangeOf(model, s.start, s.end),
      options: shown
        ? { inlineClassName: 'eva-md-syntax' }
        : { inlineClassName: 'eva-md-conceal', inlineClassNameAffectsLetterSpacing: true },
    })
  }
  return out
}

/** A block keeps its zone while it stays where it starts; its content may change under it. */
const blockKey = (b: Block): string => `${b.kind}:${b.startLine}`

/** Draws the model of `editor` rendered until `dispose`. */
export function attachLivePreview(editor: Editor, opts: LivePreviewOptions): LivePreview {
  const host = editor.getContainerDomNode()
  const decorations = editor.createDecorationsCollection()
  // The editor has setHiddenAreas at runtime (folding hides lines with it); monaco.d.ts omits it.
  const hiding = editor as Editor & {
    setHiddenAreas(ranges: monaco.IRange[], source?: unknown): void
  }
  const hideLines = (ranges: monaco.IRange[]): void => hiding.setHiddenAreas(ranges, HIDDEN_SOURCE)
  let layout: MdLayout = {
    lines: new Map(),
    spans: [],
    syntax: [],
    links: [],
    tasks: [],
    bullets: [],
    blocks: [],
  }
  let agents: readonly AgentMark[] = []
  /** The block a click opened, until the caret is in it. */
  let opening: number | null = null
  const zones = new Map<
    string,
    { id: string; zone: monaco.editor.IViewZone; slot: BlockSlot; seen: ResizeObserver }
  >()
  let frame = 0
  let disposed = false

  const selections = (): Array<[number, number]> => {
    const model = editor.getModel()
    if (!model || !editor.hasTextFocus()) return []
    return (editor.getSelections() ?? []).map((s) => [
      model.getOffsetAt(s.getStartPosition()),
      model.getOffsetAt(s.getEndPosition()),
    ])
  }

  const caretLines = (): Array<[number, number]> =>
    (editor.getSelections() ?? []).map((s) => [s.startLineNumber, s.endLineNumber])

  /** A block shows its lines while the caret is in it and Isaac is in the editor (or selecting). */
  const isOpen = (b: Block): boolean =>
    opening === b.startLine ||
    (editor.getSelections() ?? []).some(
      (s) =>
        b.startLine <= s.endLineNumber &&
        s.startLineNumber <= b.endLine &&
        (editor.hasTextFocus() || !s.isEmpty()),
    )

  const agentsOn = (b: Block): AgentMark[] =>
    agents.filter((m) => m.ranges.some((r) => r.startLine <= b.endLine && b.startLine <= r.endLine))

  const publish = (): void => opts.onBlocks([...zones.values()].map((z) => z.slot))

  /** Hides the lines of every closed block and shows its rendered form in their place. */
  const syncBlocks = (): void => {
    const model = editor.getModel()
    if (!model) return
    let closed = layout.blocks.filter((b) => !isOpen(b) && b.endLine <= model.getLineCount())
    const hidden = closed.reduce((n, b) => n + b.endLine - b.startLine + 1, 0)
    // Monaco needs one visible line; a file that is one table shows its lines.
    if (hidden >= model.getLineCount()) closed = []
    const want = new Map(closed.map((b) => [blockKey(b), b]))
    let changed = false
    editor.changeViewZones((acc) => {
      for (const [key, z] of zones) {
        if (want.has(key)) continue
        acc.removeZone(z.id)
        z.seen.disconnect()
        zones.delete(key)
        changed = true
      }
      for (const [key, block] of want) {
        const had = zones.get(key)
        if (had) {
          if (had.slot.block.source !== block.source || had.slot.block.endLine !== block.endLine) {
            had.slot = { ...had.slot, block }
            changed = true
          }
          continue
        }
        const el = document.createElement('div')
        el.className = 'eva-md-zone'
        const zone: monaco.editor.IViewZone = {
          afterLineNumber: block.startLine - 1,
          heightInPx: 32,
          domNode: el,
          suppressMouseDown: true,
          // It sits where its hidden lines are.
          showInHiddenAreas: true,
        }
        const id = acc.addZone(zone)
        const slot: BlockSlot = {
          key,
          block,
          el,
          agents: agentsOn(block),
          open: () => {
            const now = zones.get(key)
            if (now) openBlock(now.slot.block)
          },
        }
        // The rendered form sizes the zone (it portals in later, and images load later still).
        const seen = new ResizeObserver(() => {
          const h = (el.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0
          if (h > 0 && h !== zone.heightInPx) {
            zone.heightInPx = h
            editor.changeViewZones((a) => a.layoutZone(id))
          }
        })
        const watch = new MutationObserver(() => {
          const child = el.firstElementChild
          if (child) {
            seen.observe(child)
            watch.disconnect()
          }
        })
        watch.observe(el, { childList: true })
        zones.set(key, { id, zone, slot, seen })
        changed = true
      }
    })
    hideLines(closed.map((b) => new monaco.Range(b.startLine, 1, b.endLine, 1)))
    for (const z of zones.values()) {
      const now = agentsOn(z.slot.block)
      if (now.length !== z.slot.agents.length || now.some((m, i) => m !== z.slot.agents[i])) {
        z.slot = { ...z.slot, agents: now }
        changed = true
      }
    }
    if (changed) publish()
  }

  const draw = (): void => {
    frame = 0
    const model = editor.getModel()
    if (disposed || !model) return
    decorations.set(previewDecorations(model, layout, selections()))
    syncBlocks()
  }
  const schedule = (): void => {
    if (frame === 0) frame = requestAnimationFrame(draw)
  }
  const relayout = (): void => {
    const model = editor.getModel()
    layout = model ? layoutMarkdown(model.getValue()) : { ...layout, blocks: [] }
    schedule()
  }

  const openBlock = (block: Block): void => {
    opening = block.startLine
    draw()
    editor.setSelection(new monaco.Range(block.startLine, 1, block.startLine, 1))
    editor.revealLineInCenterIfOutsideViewport(block.startLine)
    editor.focus()
  }

  /** Centers a column at most MEASURE wide: the side margins are line-decoration space. */
  const fitColumn = (): void => {
    const box = editor.getLayoutInfo()
    const side = Math.max(
      MIN_SIDE,
      Math.floor((box.width - box.verticalScrollbarWidth - MEASURE) / 2),
    )
    const content = box.width - box.verticalScrollbarWidth - side * 2
    const ch = editor.getOption(monaco.editor.EditorOption.fontInfo).typicalHalfwidthCharacterWidth
    const column = Math.max(20, Math.floor(content / Math.max(1, ch)))
    host.style.setProperty('--eva-md-measure', `${String(content)}px`)
    if (
      editor.getOption(monaco.editor.EditorOption.lineDecorationsWidth) !== side ||
      editor.getOption(monaco.editor.EditorOption.wordWrapColumn) !== column
    )
      editor.updateOptions({ lineDecorationsWidth: side, wordWrapColumn: column })
  }

  /**
   * A file opening on its first line puts the caret after its frontmatter, which stays drawn as
   * properties until Isaac clicks it (a restored view state puts the caret back after this).
   */
  const startAfterFrontmatter = (): void => {
    const first = layout.blocks[0]
    const at = editor.getSelection()
    if (first?.startLine !== 1 || !at?.isEmpty() || at.startLineNumber !== 1) return
    editor.setPosition({
      lineNumber: Math.min(first.endLine + 1, editor.getModel()?.getLineCount() ?? 1),
      column: 1,
    })
  }

  host.classList.add('eva-md-prose')
  fitColumn()
  relayout()

  const subs = [
    editor.onDidChangeModelContent(relayout),
    editor.onDidChangeModel(() => {
      relayout()
      startAfterFrontmatter()
    }),
    editor.onDidChangeCursorSelection(() => {
      if (opening !== null && caretLines().some(([a, z]) => a <= opening! && opening! <= z))
        opening = null
      schedule()
    }),
    editor.onDidFocusEditorText(schedule),
    editor.onDidBlurEditorText(schedule),
    editor.onDidLayoutChange(fitColumn),
    editor.onMouseDown((e) => {
      const model = editor.getModel()
      const pos = e.target.position
      const el = e.target.element
      if (!model || !pos || !el) return
      const at = model.getOffsetAt(pos)
      if (el.classList.contains('eva-md-task')) {
        // The box is 3 characters; a click on it lands on one of its 4 edges.
        const box = layout.tasks.find((t) => at >= t.start && at <= t.start + 3)
        if (!box) return
        editor.executeEdits('eva-md-task', [
          { range: rangeOf(model, box.start, box.start + 3), text: box.checked ? '[ ]' : '[x]' },
        ])
        editor.pushUndoStop()
        return
      }
      if ((e.event.metaKey || e.event.ctrlKey) && el.closest('.eva-md-link')) {
        const link = layout.links.find((l) => at >= l.start && at <= l.end)
        if (link) {
          e.event.preventDefault()
          opts.openLink(link.url)
        }
      }
    }),
  ]

  return {
    setAgents(marks) {
      agents = marks
      schedule()
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(frame)
      for (const s of subs) s.dispose()
      decorations.clear()
      hideLines([])
      editor.changeViewZones((acc) => {
        for (const z of zones.values()) {
          acc.removeZone(z.id)
          z.seen.disconnect()
        }
      })
      zones.clear()
      opts.onBlocks([])
      host.classList.remove('eva-md-prose')
      host.style.removeProperty('--eva-md-measure')
    },
  }
}
