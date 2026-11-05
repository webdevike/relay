import {
  IconFiles,
  IconGlobe,
  IconListCheck,
  IconPhotoSpark,
  IconSchema,
  IconTerminal2,
} from '@tabler/icons-react'
import { placeOf, type Place, type ToolTab } from '@evaos/shell-core'
import { openWebPage } from './web-tabs'
import { openPlaceInPane, openTab } from './tiling-store'

/** What a tool adds: a tool tab, a page, or a new browser page ('web'). */
export type ToolAdd = ToolTab | Place | 'web'

export interface ToolEntry {
  id: string
  label: string
  Icon: typeof IconGlobe
  add: ToolAdd
  /** The real chord that opens it, as shown; absent when it has none. */
  shortcut?: string
}

/** Every tool a pane can add, in menu order: the + menu lists all, the launcher the ones it names. */
export const TOOLS: readonly ToolEntry[] = [
  { id: 'browser', label: 'Browser page', Icon: IconGlobe, add: 'web', shortcut: '⌘T' },
  { id: 'files', label: 'Files', Icon: IconFiles, add: { kind: 'files' }, shortcut: '⌘P' },
  {
    id: 'terminal',
    label: 'Terminal',
    Icon: IconTerminal2,
    add: { kind: 'terminal' },
    shortcut: '⌃`',
  },
  { id: 'canvas', label: 'Canvas', Icon: IconSchema, add: placeOf('canvas') },
  { id: 'studio', label: 'Studio', Icon: IconPhotoSpark, add: placeOf('studio') },
  { id: 'test-bench', label: 'Test Bench', Icon: IconListCheck, add: placeOf('test-bench') },
]

/** Adds `add` as a tab of `pane` (a browser page, a tool tab, or a page tab there). */
export function openToolIn(add: ToolAdd, pane: string): void {
  if (add === 'web') void openWebPage({ pane })
  else if ('kind' in add) openTab(add, pane)
  else openPlaceInPane(add, pane)
}
