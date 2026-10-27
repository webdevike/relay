import { useEffect, useRef } from 'react'
import { useColorScheme, useThemeConfig } from '../theme/theme-config'
import { registerPageChord } from '../hotkeys/router'
import {
  saveTab,
  setDirty,
  setEditorBridge,
  useFiles,
  useSpace,
  type EditorTab,
  type Reveal,
} from './files-store'
import { nameOf } from './tree-model'
import { applyEvaTheme, languageFor, monaco } from './monaco-setup'

type Model = monaco.editor.ITextModel

/** Buffers outlive tab switches: one model per open file, with its clean version and view. */
const models = new Map<string, Model>()
const cleanVersion = new Map<string, number>()
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>()
/** The disk load each model last took in, so a reload applies once. */
const loadedId = new Map<string, number>()
/** The last quick-open or search jump applied, so switching tabs never repeats one. */
let appliedReveal = 0

const keyOf = (root: string, path: string): string => `${root}\0${path}`

function modelFor(root: string, path: string, text: string): Model {
  const key = keyOf(root, path)
  let model = models.get(key)
  if (!model || model.isDisposed()) {
    const uri = monaco.Uri.file(`${root}/${path}`)
    monaco.editor.getModel(uri)?.dispose()
    model = monaco.editor.createModel(text, languageFor(nameOf(path)), uri)
    models.set(key, model)
    cleanVersion.set(key, model.getAlternativeVersionId())
  }
  return model
}

/** Drops the buffers of tabs that closed. */
function pruneModels(root: string, open: ReadonlySet<string>): void {
  for (const [key, model] of models) {
    const [r, p] = key.split('\0') as [string, string]
    if (r !== root || open.has(p)) continue
    model.dispose()
    models.delete(key)
    cleanVersion.delete(key)
    viewStates.delete(key)
    loadedId.delete(key)
  }
}

setEditorBridge({
  text: (root, path) => models.get(keyOf(root, path))?.getValue() ?? null,
  markClean: (root, path) => {
    const key = keyOf(root, path)
    const model = models.get(key)
    if (model) cleanVersion.set(key, model.getAlternativeVersionId())
  },
})

/** The nearest painted background above `el`, so the editor sits on the panel's surface. */
function surfaceOf(el: HTMLElement): HTMLElement {
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const bg = getComputedStyle(n).backgroundColor
    if (bg && !/rgba?\(.*[,/]\s*0\s*\)$/.test(bg) && bg !== 'transparent') return n
  }
  return el
}

function applyReveal(editor: monaco.editor.IStandaloneCodeEditor, r: Reveal): void {
  const model = editor.getModel()
  if (!model) return
  const line = Math.min(Math.max(1, r.line), model.getLineCount())
  const col = Math.min(Math.max(1, r.column), model.getLineMaxColumn(line))
  const range = new monaco.Range(
    line,
    col,
    line,
    Math.min(col + r.length, model.getLineMaxColumn(line)),
  )
  editor.setSelection(range)
  editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Immediate)
  editor.focus()
}

export interface CodeEditorProps {
  root: string
  tab: EditorTab & { content: { kind: 'text'; text: string } }
}

/** One Monaco editor for the active text tab; switching tabs swaps models and view state. */
export function CodeEditor({ root, tab }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const current = useRef<string | null>(null)
  const scheme = useColorScheme()
  const config = useThemeConfig()
  const reveal = useSpace((w) => w.reveal, null)
  const openPaths = useSpace((w) => w.tabs.map((t) => t.path).join('\0'), '')
  const quickOpen = useFiles((s) => s.quickOpen)

  // Create once.
  useEffect(() => {
    const el = host.current
    if (!el) return
    const font = getComputedStyle(el).getPropertyValue('--eva-font-code').trim()
    const editor = monaco.editor.create(el, {
      model: null,
      automaticLayout: true,
      minimap: { enabled: false },
      multiCursorModifier: 'alt',
      fontFamily: font || undefined,
      fontSize: 13,
      lineHeight: 20,
      fontLigatures: false,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderLineHighlight: 'line',
      roundedSelection: true,
      cursorBlinking: 'smooth',
      padding: { top: 8, bottom: 8 },
      fixedOverflowWidgets: true,
      tabSize: 2,
      detectIndentation: true,
      bracketPairColorization: { enabled: true },
      guides: { indentation: true, bracketPairs: false },
      stickyScroll: { enabled: true },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      overviewRulerLanes: 2,
      hideCursorInOverviewRuler: true,
      find: { addExtraSpaceOnTop: false, seedSearchStringFromSelection: 'selection' },
    })
    editorRef.current = editor
    const offContent = editor.onDidChangeModelContent(() => {
      const model = editor.getModel()
      const key = current.current
      if (!model || key === null) return
      const [r, p] = key.split('\0') as [string, string]
      setDirty(r, p, model.getAlternativeVersionId() !== cleanVersion.get(key))
    })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const key = current.current
      if (key === null) return
      const [r, p] = key.split('\0') as [string, string]
      void saveTab(r, p, false)
    })
    // Cmd+F is the app's search chord; inside the editor it opens the editor's own find. Esc
    // closes the editor's find widget and extra cursors before any app overlay.
    const inEditor = (): 'yield' | false => (editor.hasWidgetFocus() ? 'yield' : false)
    const offFind = registerPageChord('cmd+f', inEditor)
    const offEsc = registerPageChord('escape', inEditor)
    return () => {
      offFind()
      offEsc()
      offContent.dispose()
      const key = current.current
      if (key !== null) viewStates.set(key, editor.saveViewState())
      editor.dispose()
      editorRef.current = null
      current.current = null
    }
  }, [])

  // Theme follows the app (light/dark and the theme settings).
  useEffect(() => {
    const el = host.current
    if (el) applyEvaTheme(surfaceOf(el), scheme === 'dark')
  }, [scheme, config])

  // Swap in the tab's model; reload a clean buffer when the disk version changed.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const key = keyOf(root, tab.path)
    const model = modelFor(root, tab.path, tab.content.text)
    if (loadedId.get(key) === undefined) loadedId.set(key, tab.loadId)
    else if (loadedId.get(key) !== tab.loadId) {
      loadedId.set(key, tab.loadId)
      if (model.getValue() !== tab.content.text) {
        model.pushEditOperations(
          [],
          [{ range: model.getFullModelRange(), text: tab.content.text }],
          () => null,
        )
      }
      cleanVersion.set(key, model.getAlternativeVersionId())
      setDirty(root, tab.path, false)
    }
    if (current.current !== key) {
      if (current.current !== null) viewStates.set(current.current, editor.saveViewState())
      current.current = key
      editor.setModel(model)
      const view = viewStates.get(key)
      if (view) editor.restoreViewState(view)
      if (!quickOpen) editor.focus()
    }
  }, [root, tab.path, tab.loadId, tab.content.text, quickOpen])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !reveal || reveal.path !== tab.path || reveal.nonce === appliedReveal) return
    appliedReveal = reveal.nonce
    applyReveal(editor, reveal)
  }, [reveal, tab.path])

  useEffect(() => {
    pruneModels(root, new Set(openPaths.split('\0')))
  }, [root, openPaths])

  return <div ref={host} className="eva-files-monaco" data-testid="files-editor" />
}
