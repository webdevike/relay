// File and folder icons from the Material Icon Theme (VS Code's most used icon theme, MIT). The
// manifest is VS Code's icon-theme format; this resolves a name the way VS Code does: exact file
// name, then the longest dotted extension (`test.ts` before `ts`), then the language id, then the
// default. Folders match by name, open or closed. Light themes swap in the `light` overrides.
import manifest from 'material-icon-theme/dist/material-icons.json'

interface Associations {
  fileExtensions?: Record<string, string>
  fileNames?: Record<string, string>
  languageIds?: Record<string, string>
  folderNames?: Record<string, string>
  folderNamesExpanded?: Record<string, string>
}

interface Manifest extends Associations {
  iconDefinitions: Record<string, { iconPath: string }>
  file: string
  folder: string
  folderExpanded: string
  light: Associations
}

const theme = manifest as unknown as Manifest

/** Extensions whose icon the manifest only gives through a language id. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  bash: 'shellscript',
  zsh: 'shellscript',
  mts: 'typescript',
  cts: 'typescript',
  txt: 'plaintext',
}

export interface IconQuery {
  name: string
  kind: 'file' | 'dir'
  expanded?: boolean
  light?: boolean
}

function pick(table: keyof Associations, key: string, light: boolean): string | undefined {
  if (light) {
    const l = theme.light[table]?.[key]
    if (l) return l
  }
  return theme[table]?.[key]
}

/** The manifest icon id for a file or folder name (no path). */
export function iconId(q: IconQuery): string {
  const name = q.name.toLowerCase()
  const light = q.light === true
  if (q.kind === 'dir') {
    const id = pick(q.expanded ? 'folderNamesExpanded' : 'folderNames', name, light)
    return id ?? (q.expanded ? theme.folderExpanded : theme.folder)
  }
  const exact = pick('fileNames', name, light)
  if (exact) return exact
  // `a.test.ts` tries `test.ts`, then `ts`; a dotfile like `.bashrc` tries `bashrc` (as VS Code).
  const parts = name.split('.')
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join('.')
    const id = pick('fileExtensions', ext, light)
    if (id) return id
  }
  const ext = parts.length > 1 ? parts[parts.length - 1]! : ''
  const lang = LANGUAGE_BY_EXT[ext]
  if (lang) {
    const id = pick('languageIds', lang, light)
    if (id) return id
  }
  return theme.file
}

// Every icon as its own asset (never inlined), so the browser fetches only the ones on screen.
const URLS = import.meta.glob<string>('../../../node_modules/material-icon-theme/icons/*.svg', {
  eager: true,
  query: '?no-inline',
  import: 'default',
})
const URL_BY_FILE = new Map<string, string>()
for (const [file, url] of Object.entries(URLS)) {
  URL_BY_FILE.set(file.slice(file.lastIndexOf('/') + 1), url)
}

function urlOf(id: string): string | undefined {
  const def = theme.iconDefinitions[id]
  return def ? URL_BY_FILE.get(def.iconPath.slice(def.iconPath.lastIndexOf('/') + 1)) : undefined
}

/** The icon's URL; ids without an svg fall back to the default file or folder icon. */
export function iconUrl(q: IconQuery): string {
  const fallback =
    q.kind === 'dir' ? (q.expanded ? theme.folderExpanded : theme.folder) : theme.file
  return urlOf(iconId(q)) ?? urlOf(fallback) ?? ''
}
