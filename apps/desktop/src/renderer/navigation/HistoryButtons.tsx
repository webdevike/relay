import { ActionIcon, Kbd, Tooltip } from '@mantine/core'
import { IconArrowLeft, IconArrowRight } from '@tabler/icons-react'
import { useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import type { Spot } from '@evaos/shell-core'
import { EvaMenu } from '../overlay'
import { tabTitle } from '../tabs/tab-meta'
import { paneTabTitle } from '../tiling/pane-tab-meta'
import { toolTabOfId } from '../tiling/tiling-store'
import {
  canGoBack,
  canGoForward,
  historyBack,
  historyForward,
  historyJump,
  useNavHistory,
} from './nav-history'

/** How many entries the long-press list shows. */
const LIST_LENGTH = 10
const LONG_PRESS_MS = 450

type Dir = 'back' | 'forward'

/** What an entry reads as in the list: its place, then the tool tab that was in front. */
function spotLabel(spot: Spot): string {
  const tool = spot.front === null ? null : toolTabOfId(spot.front)
  return tool ? `${tabTitle(spot.place)} \u00b7 ${paneTabTitle(tool)}` : tabTitle(spot.place)
}

/** The entries one way from where Isaac is, nearest first. */
function entriesToward(dir: Dir, entries: Spot[], index: number): { index: number; spot: Spot }[] {
  const out: { index: number; spot: Spot }[] = []
  for (
    let i = index + (dir === 'back' ? -1 : 1);
    out.length < LIST_LENGTH;
    i += dir === 'back' ? -1 : 1
  ) {
    const spot = entries[i]
    if (!spot) break
    out.push({ index: i, spot })
  }
  return out
}

function HistoryButton({ dir }: { dir: Dir }) {
  const enabled = useNavHistory(dir === 'back' ? canGoBack : canGoForward)
  const entries = useNavHistory((h) => h.entries)
  const index = useNavHistory((h) => h.index)
  const [opened, setOpened] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressed = useRef(false)
  const label = dir === 'back' ? 'Back' : 'Forward'

  const clear = (): void => {
    clearTimeout(timer.current ?? undefined)
    timer.current = null
  }
  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !enabled) return
    longPressed.current = false
    clear()
    timer.current = setTimeout(() => {
      longPressed.current = true
      setOpened(true)
    }, LONG_PRESS_MS)
  }
  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
    if (enabled) setOpened(true)
  }
  const onClick = (): void => {
    // The press that opened the list is not also a click.
    if (longPressed.current) {
      longPressed.current = false
      return
    }
    if (dir === 'back') historyBack()
    else historyForward()
  }

  return (
    <EvaMenu opened={opened} onChange={setOpened} width={260} position="bottom-start" offset={4}>
      <EvaMenu.Target>
        <Tooltip
          label={
            <span className="eva-tip">
              {label} <Kbd size="xs">{dir === 'back' ? '\u2318[' : '\u2318]'}</Kbd>
            </span>
          }
          position="bottom"
          openDelay={400}
          disabled={opened}
        >
          <ActionIcon
            variant="subtle"
            className="eva-tabbar-btn"
            data-testid={`history-${dir}`}
            aria-label={label}
            disabled={!enabled}
            onClick={onClick}
            onContextMenu={onContextMenu}
            onPointerDown={onPointerDown}
            onPointerUp={clear}
            onPointerLeave={clear}
          >
            {dir === 'back' ? (
              <IconArrowLeft size={16} stroke={1.5} />
            ) : (
              <IconArrowRight size={16} stroke={1.5} />
            )}
          </ActionIcon>
        </Tooltip>
      </EvaMenu.Target>
      <EvaMenu.Dropdown data-testid={`history-${dir}-list`}>
        {opened
          ? entriesToward(dir, entries, index).map((e) => (
              <EvaMenu.Item
                key={e.index}
                data-testid="history-entry"
                onClick={() => historyJump(e.index)}
              >
                {spotLabel(e.spot)}
              </EvaMenu.Item>
            ))
          : null}
      </EvaMenu.Dropdown>
    </EvaMenu>
  )
}

/**
 * The window's one Back and Forward (⌘[ and ⌘]; ⌘← and ⌘→ outside text fields; mouse buttons 4
 * and 5; a trackpad swipe). Right-click or hold either for the last entries that way.
 */
export function HistoryButtons() {
  return (
    <>
      <HistoryButton dir="back" />
      <HistoryButton dir="forward" />
    </>
  )
}
