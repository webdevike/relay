import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { FileContent, FileEntry, FileVersion, GitStatus, SearchResult } from '@evaos/contract'
import { registerDirty } from '../dirty/dirty-store'
import { invoke, on } from '../ipc'
import { ancestorsOf, nameOf, parentOf } from './tree-model'

export interface EditorTab {
  path: string
  /** A preview tab (single click) is replaced by the next preview until edited or pinned. */
  pinned: boolean
  content: FileContent | null
  error: string | null
  /** The disk version the buffer is based on (text files). */
  version: FileVersion | null
  dirty: boolean
  /** The disk moved on under unsaved edits, or a save found it changed. */
  conflict: boolean
  /** Bumped when `content` was replaced from disk; the editor reloads its buffer. */
  loadId: number
}

export interface SearchOptions {
  query: string
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
}

export interface SearchState extends SearchOptions {
  running: boolean
  result: SearchResult | null
  error: string | null
}

/** Where the editor should put the cursor once the file is open (quick open `:line`, search). */
export interface Reveal {
  path: string
  line: number
  column: number
  length: number
  nonce: number
}

export interface Workspace {
  root: string
  name: string
  /** Listed folders by root-relative path ('' is the root). */
  children: Record<string, FileEntry[]>
  expanded: Set<string>
  git: GitStatus | null
  showIgnored: boolean
  /** The tree's cursor row. */
  selected: string | null
  tabs: EditorTab[]
  active: string | null
  /** Most recent first, for quick open. */
  recent: string[]
  allFiles: string[] | null
  search: SearchState
  reveal: Reveal | null
  /** A dirty tab waiting on Save / Close without saving / Cancel. */
  closing: string | null
  error: string | null
}

export type SideView = 'explorer' | 'search'

export interface FilesState {
  root: string | null
  spaces: Record<string, Workspace>
  side: SideView
  sideOpen: boolean
  quickOpen: boolean
  /** Bumped by Cmd+Shift+F: the search input takes focus each time. */
  searchFocus: number
}

export const filesStore = createStore<FilesState>(() => ({
  root: null,
  spaces: {},
  side: 'explorer',
  sideOpen: true,
  quickOpen: false,
  searchFocus: 0,
}))

export function useFiles<T>(selector: (s: FilesState) => T): T {
  return useStore(filesStore, selector)
}

export function currentSpace(s: FilesState): Workspace | null {
  return s.root === null ? null : (s.spaces[s.root] ?? null)
}

export function useSpace<T>(selector: (w: Workspace) => T, fallback: T): T {
  return useStore(filesStore, (s) => {
    const w = currentSpace(s)
    return w ? selector(w) : fallback
  })
}

function update(root: string, fn: (w: Workspace) => Partial<Workspace>): void {
  filesStore.setState((s) => {
    const w = s.spaces[root]
    if (!w) return s
    return { spaces: { ...s.spaces, [root]: { ...w, ...fn(w) } } }
  })
}

function space(root: string): Workspace | undefined {
  return filesStore.getState().spaces[root]
}

function updateTab(root: string, path: string, patch: Partial<EditorTab>): void {
  update(root, (w) => ({ tabs: w.tabs.map((t) => (t.path === path ? { ...t, ...patch } : t)) }))
}

/** What the editor exposes so a save can read the buffer and mark it clean. */
export interface EditorBridge {
  text(root: string, path: string): string | null
  markClean(root: string, path: string): void
}
let bridge: EditorBridge | null = null
export function setEditorBridge(b: EditorBridge | null): void {
  bridge = b
}

// Root resolution -------------------------------------------------------------------------

let rootSeq = 0

/** Points the panel at the chat's root (its worktree), or the Eva root without a chat. */
export async function followChat(file: string | null): Promise<void> {
  const seq = ++rootSeq
  const r = await invoke('files.root', { file })
  if (seq !== rootSeq || !r.ok) return
  const { root, name } = r.value
  if (!space(root)) {
    filesStore.setState((s) => ({
      spaces: {
        ...s.spaces,
        [root]: {
          root,
          name,
          children: {},
          expanded: new Set(),
          git: null,
          showIgnored: false,
          selected: null,
          tabs: [],
          active: null,
          recent: [],
          allFiles: null,
          search: {
            query: '',
            regex: false,
            caseSensitive: false,
            wholeWord: false,
            running: false,
            result: null,
            error: null,
          },
          reveal: null,
          closing: null,
          error: null,
        },
      },
    }))
  }
  filesStore.setState({ root })
  if (space(root)?.children[''] === undefined) void loadDir(root, '')
  void refreshGit(root)
  syncWatch(root)
}

// Tree ------------------------------------------------------------------------------------

const loadingDirs = new Set<string>()

export async function loadDir(root: string, dir: string): Promise<void> {
  const key = `${root}\0${dir}`
  if (loadingDirs.has(key)) return
  loadingDirs.add(key)
  try {
    const r = await invoke('files.list', { root, dir })
    if (!r.ok) {
      // A folder that vanished drops out of the tree.
      update(root, (w) => {
        const children = { ...w.children }
        delete children[dir]
        const expanded = new Set(w.expanded)
        expanded.delete(dir)
        return { children, expanded, error: dir === '' ? r.error.message : w.error }
      })
      return
    }
    update(root, (w) => ({ children: { ...w.children, [dir]: r.value.entries } }))
  } finally {
    loadingDirs.delete(key)
  }
}

export function setExpanded(root: string, dir: string, open: boolean): void {
  update(root, (w) => {
    const expanded = new Set(w.expanded)
    if (open) expanded.add(dir)
    else expanded.delete(dir)
    return { expanded }
  })
  if (open && space(root)?.children[dir] === undefined) void loadDir(root, dir)
  syncWatch(root)
}

export function collapseAll(root: string): void {
  update(root, () => ({ expanded: new Set() }))
  syncWatch(root)
}

export function select(root: string, path: string | null): void {
  update(root, () => ({ selected: path }))
}

export function setShowIgnored(root: string, show: boolean): void {
  update(root, () => ({ showIgnored: show }))
}

/** Expands every folder above `path` and moves the tree cursor to it. */
export function revealInTree(root: string, path: string): void {
  const dirs = ancestorsOf(path)
  update(root, (w) => ({ expanded: new Set([...w.expanded, ...dirs]), selected: path }))
  const w = space(root)
  for (const d of dirs) if (w && w.children[d] === undefined) void loadDir(root, d)
  syncWatch(root)
}

// Git -------------------------------------------------------------------------------------

const gitTimers = new Map<string, number>()

export async function refreshGit(root: string): Promise<void> {
  const r = await invoke('files.gitStatus', { root })
  if (r.ok) update(root, () => ({ git: r.value }))
}

function refreshGitSoon(root: string): void {
  window.clearTimeout(gitTimers.get(root))
  gitTimers.set(
    root,
    window.setTimeout(() => void refreshGit(root), 400),
  )
}

// Tabs ------------------------------------------------------------------------------------

export interface OpenOptions {
  pin?: boolean
  line?: number
  column?: number
  length?: number
}

let revealNonce = 0

export function openFile(root: string, path: string, opts: OpenOptions = {}): void {
  const w = space(root)
  if (!w) return
  const pin = opts.pin === true
  const existing = w.tabs.find((t) => t.path === path)
  const reveal: Reveal | null =
    opts.line === undefined
      ? null
      : {
          path,
          line: opts.line,
          column: opts.column ?? 1,
          length: opts.length ?? 0,
          nonce: ++revealNonce,
        }
  const recent = [path, ...w.recent.filter((p) => p !== path)].slice(0, 50)
  if (existing) {
    update(root, (s) => ({
      active: path,
      selected: path,
      recent,
      reveal: reveal ?? s.reveal,
      tabs: pin ? s.tabs.map((t) => (t.path === path ? { ...t, pinned: true } : t)) : s.tabs,
    }))
    syncWatch(root)
    return
  }
  const tab: EditorTab = {
    path,
    pinned: pin,
    content: null,
    error: null,
    version: null,
    dirty: false,
    conflict: false,
    loadId: 0,
  }
  update(root, (s) => {
    // The open preview tab gives its place to the new file.
    const at = s.tabs.findIndex((t) => !t.pinned && !t.dirty)
    const tabs = [...s.tabs]
    if (at >= 0) tabs.splice(at, 1, tab)
    else {
      const after = s.tabs.findIndex((t) => t.path === s.active)
      tabs.splice(after + 1, 0, tab)
    }
    return { tabs, active: path, selected: path, recent, reveal: reveal ?? s.reveal }
  })
  syncWatch(root)
  void readTab(root, path)
}

async function readTab(root: string, path: string): Promise<void> {
  const r = await invoke('files.read', { root, path })
  if (!r.ok) {
    updateTab(root, path, { error: r.error.message })
    return
  }
  const content = r.value
  update(root, (w) => ({
    tabs: w.tabs.map((t) =>
      t.path === path
        ? {
            ...t,
            content,
            error: null,
            version: content.kind === 'text' ? content.version : null,
            loadId: t.loadId + 1,
          }
        : t,
    ),
  }))
}

export function pinTab(root: string, path: string): void {
  updateTab(root, path, { pinned: true })
}

export function activateTab(root: string, path: string): void {
  update(root, () => ({ active: path }))
}

/** Closes a clean tab now; a dirty one asks first (EditorArea shows the question). */
export function requestCloseTab(root: string, path: string): void {
  const tab = space(root)?.tabs.find((t) => t.path === path)
  if (!tab) return
  if (tab.dirty) update(root, () => ({ closing: path }))
  else closeTab(root, path)
}

export function setClosingPath(root: string, path: string | null): void {
  update(root, () => ({ closing: path }))
}

/** Closes a tab (unsaved edits are dropped; ask first). The neighbor to the right takes over. */
export function closeTab(root: string, path: string): void {
  setDirty(root, path, false)
  update(root, (w) => {
    const i = w.tabs.findIndex((t) => t.path === path)
    if (i < 0) return {}
    const tabs = w.tabs.filter((t) => t.path !== path)
    const active = w.active === path ? (tabs[Math.min(i, tabs.length - 1)]?.path ?? null) : w.active
    return { tabs, active }
  })
  syncWatch(root)
}

export function moveTab(root: string, from: number, to: number): void {
  update(root, (w) => {
    const tabs = [...w.tabs]
    const [t] = tabs.splice(from, 1)
    if (t) tabs.splice(to, 0, t)
    return { tabs }
  })
}

const dirtyOff = new Map<string, () => void>()

/** The editor reports a buffer turned dirty or clean; dirty tabs join the quit guard. */
export function setDirty(root: string, path: string, dirty: boolean): void {
  const key = `${root}/${path}`
  const tab = space(root)?.tabs.find((t) => t.path === path)
  if (tab && tab.dirty !== dirty) updateTab(root, path, dirty ? { dirty, pinned: true } : { dirty })
  if (dirty && !dirtyOff.has(key)) {
    dirtyOff.set(
      key,
      registerDirty(`files:${key}`, {
        label: nameOf(path),
        save: async () => {
          const r = await saveTab(root, path, false)
          if (r !== 'saved') throw new Error(`${nameOf(path)} was not saved: ${r}`)
        },
      }),
    )
  } else if (!dirty) {
    dirtyOff.get(key)?.()
    dirtyOff.delete(key)
  }
}

export type SaveOutcome = 'saved' | 'conflict' | 'failed' | 'nothing'

/** Saves the buffer. `force` writes over a disk version that changed since it loaded. */
export async function saveTab(root: string, path: string, force: boolean): Promise<SaveOutcome> {
  const tab = space(root)?.tabs.find((t) => t.path === path)
  const text = bridge?.text(root, path) ?? null
  if (!tab || text === null || tab.content?.kind !== 'text') return 'nothing'
  const r = await invoke('files.save', { root, path, text, expected: tab.version, force })
  if (!r.ok) {
    if (r.error.code === 'changed-on-disk') {
      updateTab(root, path, { conflict: true })
      return 'conflict'
    }
    updateTab(root, path, { error: null })
    update(root, () => ({ error: `Could not save ${nameOf(path)}: ${r.error.message}` }))
    return 'failed'
  }
  bridge?.markClean(root, path)
  updateTab(root, path, {
    version: r.value.version,
    content: { kind: 'text', text, version: r.value.version },
    conflict: false,
  })
  setDirty(root, path, false)
  refreshGitSoon(root)
  return 'saved'
}

/** Drops unsaved edits and loads what is on disk now. */
export async function reloadTab(root: string, path: string): Promise<void> {
  updateTab(root, path, { conflict: false })
  setDirty(root, path, false)
  await readTab(root, path)
}

export function clearError(root: string): void {
  update(root, () => ({ error: null }))
}

// Watching --------------------------------------------------------------------------------

const watchTimers = new Map<string, number>()

/** Main watches the expanded folders and the open files of the root in front. */
function syncWatch(root: string): void {
  window.clearTimeout(watchTimers.get(root))
  watchTimers.set(
    root,
    window.setTimeout(() => {
      const w = space(root)
      if (!w) return
      const paths = new Set<string>(['', ...w.expanded, ...w.tabs.map((t) => t.path)])
      void invoke('files.watch', { root, paths: [...paths].slice(0, 2000) })
    }, 100),
  )
}

async function onDiskChange(root: string, paths: readonly string[]): Promise<void> {
  const w = space(root)
  if (!w) return
  const seen = new Set(paths)
  for (const p of seen) if (w.children[p] !== undefined) void loadDir(root, p)
  for (const tab of w.tabs) {
    if (!seen.has(tab.path) && !seen.has(parentOf(tab.path))) continue
    if (tab.content === null) continue
    const r = await invoke('files.read', { root, path: tab.path })
    const now = space(root)?.tabs.find((t) => t.path === tab.path)
    if (!now) continue
    if (!r.ok) {
      // Deleted (or moved) on disk: a clean tab says so; a dirty one keeps its buffer.
      if (r.error.code === 'not-found' && !now.dirty)
        updateTab(root, tab.path, { error: 'This file was deleted on disk.' })
      continue
    }
    const next = r.value
    const same =
      next.kind === 'text' && now.version !== null && next.version.hash === now.version.hash
    if (same && now.error === null) continue
    if (now.dirty) updateTab(root, tab.path, { conflict: true })
    else
      updateTab(root, tab.path, {
        content: next,
        error: null,
        version: next.kind === 'text' ? next.version : null,
        loadId: now.loadId + 1,
      })
  }
  update(root, () => ({ allFiles: null }))
  refreshGitSoon(root)
}

// Quick open and search ------------------------------------------------------------------

export async function loadAllFiles(root: string): Promise<void> {
  const r = await invoke('files.all', { root })
  if (r.ok) update(root, () => ({ allFiles: r.value.files }))
}

export function setQuickOpen(open: boolean): void {
  filesStore.setState({ quickOpen: open })
}

export function focusSearch(): void {
  filesStore.setState((s) => ({ side: 'search', sideOpen: true, searchFocus: s.searchFocus + 1 }))
}

export function showSide(side: SideView | null): void {
  if (side === null) filesStore.setState({ sideOpen: false })
  else filesStore.setState({ side, sideOpen: true })
}

let searchSeq = 0

export function setSearch(root: string, patch: Partial<SearchOptions>): void {
  update(root, (w) => ({ search: { ...w.search, ...patch } }))
}

export async function runSearch(root: string): Promise<void> {
  const w = space(root)
  if (!w) return
  const { query, regex, caseSensitive, wholeWord } = w.search
  const seq = ++searchSeq
  if (query.trim() === '') {
    update(root, (s) => ({ search: { ...s.search, running: false, result: null, error: null } }))
    return
  }
  update(root, (s) => ({ search: { ...s.search, running: true, error: null } }))
  const r = await invoke('files.search', { root, query, regex, caseSensitive, wholeWord })
  if (seq !== searchSeq) return
  update(root, (s) => ({
    search: {
      ...s.search,
      running: false,
      result: r.ok ? r.value : null,
      error: r.ok ? null : r.error.message,
    },
  }))
}

export function revealFinder(root: string, path: string): void {
  void invoke('files.reveal', { root, path })
}

/** Subscribes to main's change events; returns the unsubscribe. */
export function startFiles(): () => void {
  return on('files.changed', ({ root, paths }) => void onDiskChange(root, paths))
}

/** Test seam. */
export function resetFilesStoreForTests(): void {
  for (const off of dirtyOff.values()) off()
  dirtyOff.clear()
  loadingDirs.clear()
  filesStore.setState({
    root: null,
    spaces: {},
    side: 'explorer',
    sideOpen: true,
    quickOpen: false,
    searchFocus: 0,
  })
}
