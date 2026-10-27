// Monaco, bundled: the editor and its language workers ship with the app (no CDN, no loader).
// Vite builds each `?worker` import into its own same-origin file, which the CSP's
// `script-src 'self'` allows.
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment
  }
}

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    return new EditorWorker()
  },
}

// A file is edited alone, without its project: type errors about imports would all be noise.
// Syntax errors stay.
for (const defaults of [
  monaco.typescript.typescriptDefaults,
  monaco.typescript.javascriptDefaults,
]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
  defaults.setCompilerOptions({
    jsx: monaco.typescript.JsxEmit.Preserve,
    target: monaco.typescript.ScriptTarget.ESNext,
    allowNonTsExtensions: true,
    allowJs: true,
  })
}

export { monaco }

/** Monaco's language id for a file name: exact file names first, then the longest extension. */
export function languageFor(name: string): string {
  const lower = name.toLowerCase()
  let best: { id: string; len: number } | null = null
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === lower)) return lang.id
    for (const ext of lang.extensions ?? []) {
      const e = ext.toLowerCase()
      if (lower.endsWith(e) && (best === null || e.length > best.len))
        best = { id: lang.id, len: e.length }
    }
  }
  return best?.id ?? 'plaintext'
}

/** `rgb(r g b / a)` or `rgba(r, g, b, a)` as `#rrggbb[aa]`, which Monaco themes require. */
function hex(css: string, fallback: string): string {
  const m = css.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)/)
  if (!m) return css.startsWith('#') ? css : fallback
  const to2 = (n: number): string =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, '0')
  const alpha =
    m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
  const rgb = `#${to2(+m[1]!)}${to2(+m[2]!)}${to2(+m[3]!)}`
  return alpha >= 1 ? rgb : `${rgb}${to2(alpha * 255)}`
}

/** Reads one CSS custom property off `el`, resolved to a color. */
function cssColor(el: HTMLElement, varName: string, fallback: string): string {
  const probe = document.createElement('span')
  probe.style.color = `var(${varName})`
  probe.style.display = 'none'
  el.appendChild(probe)
  const value = getComputedStyle(probe).color
  probe.remove()
  return hex(value, fallback)
}

/**
 * Defines `eva-light` / `eva-dark` from the app's Mantine variables as `el` sees them, so the
 * editor sits on the panel's own surface and picks the accent for the cursor and selection.
 */
export function applyEvaTheme(el: HTMLElement, dark: boolean): string {
  const name = dark ? 'eva-dark' : 'eva-light'
  const bg = hex(getComputedStyle(el).backgroundColor, dark ? '#1e1e1e' : '#ffffff')
  const fg = cssColor(el, '--mantine-color-text', dark ? '#d4d4d4' : '#1f1f1f')
  const dim = cssColor(el, '--mantine-color-dimmed', dark ? '#858585' : '#6e7681')
  const border = cssColor(el, '--mantine-color-default-border', dark ? '#333333' : '#e5e5e5')
  const hover = cssColor(el, '--mantine-color-default-hover', dark ? '#2a2d2e' : '#f2f2f2')
  const accent = cssColor(el, '--mantine-primary-color-filled', dark ? '#4c8dff' : '#2f6fde')
  monaco.editor.defineTheme(name, {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': bg,
      'editor.foreground': fg,
      'editorGutter.background': bg,
      'minimap.background': bg,
      'editorLineNumber.foreground': `${dim}99`,
      'editorLineNumber.activeForeground': fg,
      'editor.lineHighlightBackground': `${hover}80`,
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': accent,
      'editor.selectionBackground': `${accent}40`,
      'editor.inactiveSelectionBackground': `${accent}26`,
      'editor.selectionHighlightBackground': `${accent}1f`,
      'editor.wordHighlightBackground': `${accent}1a`,
      'editor.findMatchHighlightBackground': `${accent}33`,
      'editorIndentGuide.background1': `${border}`,
      'editorIndentGuide.activeBackground1': `${dim}66`,
      'editorWhitespace.foreground': `${dim}55`,
      'editorWidget.background': bg,
      'editorWidget.border': border,
      'editorSuggestWidget.background': bg,
      'editorSuggestWidget.border': border,
      'editorHoverWidget.background': bg,
      'editorHoverWidget.border': border,
      'input.background': bg,
      'input.border': border,
      focusBorder: `${accent}99`,
      'scrollbarSlider.background': `${dim}33`,
      'scrollbarSlider.hoverBackground': `${dim}55`,
      'scrollbarSlider.activeBackground': `${dim}77`,
      'editorOverviewRuler.border': '#00000000',
    },
  })
  monaco.editor.setTheme(name)
  return name
}
