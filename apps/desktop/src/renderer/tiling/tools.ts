import {
  IconFiles,
  IconGlobe,
  IconListCheck,
  IconPhotoSpark,
  IconSchema,
  IconTerminal2,
} from '@tabler/icons-react'
import { placeOf, type Place, type ToolTab } from '@evaos/shell-core'
import { openPlaceInPane, openTab } from './tiling-store'

export interface ToolEntry {
  id: string
  label: string
  Icon: typeof IconGlobe
  add: ToolTab | Place
  /** The real chord that opens it, as shown; absent when it has none. */
  shortcut?: string
}

/** Every tool a pane can add: the + menu lists all, the new-tab launcher the ones it names. */
export const TOOLS: readonly ToolEntry[] = [
  { id: 'browser', label: 'Browser', Icon: IconGlobe, add: { kind: 'browser' } },
  { id: 'files', label: 'Files', Icon: IconFiles, add: { kind: 'files' }, shortcut: '⌘P' },
  {
    id: 'terminal',
    label: 'Terminal',
    Icon: IconTerminal2,
    add: { kind: 'terminal' },
    shortcut: '⌃`',
  },
  { id: 'test-bench', label: 'Test Bench', Icon: IconListCheck, add: placeOf('test-bench') },
  { id: 'canvas', label: 'Canvas', Icon: IconSchema, add: placeOf('canvas') },
  { id: 'studio', label: 'Studio', Icon: IconPhotoSpark, add: placeOf('studio') },
]

/** Adds `add` as a tab of `pane` (a tool tab, or a page as an app tab there). */
export function openToolIn(add: ToolTab | Place, pane: string): void {
  if ('kind' in add) openTab(add, pane)
  else openPlaceInPane(add, pane)
}
