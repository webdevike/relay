import { createPortal } from 'react-dom'
import { IconExternalLink, IconLayoutColumns, IconPlus } from '@tabler/icons-react'
import type { Place } from '@evaos/shell-core'
import { setReviewTitle } from '../eva/names-store'
import { openPlace } from '../navigation/navigate'
import { openInApp } from '../navigation/open-in-app'
import { openLink } from '../navigation/open-link'
import { navTargetOf, type ClickMods } from '../navigation/open-target'
import { EvaMenu } from '../overlay'
import { activePlace, tabsStore } from '../tabs/tabs-store'
import { ticketPlace } from '../tickets/ticket-place'
import { reviewIdOf, reviewPlaceOf, reviewRefOf, reviewTitleOf } from './review-place'
import { openPr, openThread, type ReviewItem } from './reviews-store'

/** Remembers the item's title, so the tab it opens is named at once (and after a restart). */
function nameIt(item: ReviewItem): void {
  setReviewTitle(reviewIdOf(reviewRefOf(item)), reviewTitleOf(item))
}

/** Where a row opens: a Linear issue's ticket page (the Board's), else the item's review place. */
function rowPlace(item: ReviewItem): Place {
  return item.kind === 'linear' ? ticketPlace(item.row.key) : reviewPlaceOf(reviewRefOf(item))
}

/**
 * Opens a queue row. On the Reviews page a plain click shows a PR or thread there (as before);
 * anywhere else (a chat, another review), and for a Linear issue always, it goes to the item's own
 * place in this tab, and `newTab` (Cmd+Shift-click, middle-click, the menu) always opens its own
 * tab, so several can be open at once.
 */
export function openReviewRow(item: ReviewItem, newTab: boolean): void {
  const onPage = activePlace(tabsStore.getState()).page === 'reviews'
  if (!newTab && onPage && item.kind !== 'linear') {
    if (item.kind === 'pr') openPr(item.row)
    else openThread(item.row)
    return
  }
  nameIt(item)
  openPlace(rowPlace(item), { newTab })
}

/** The item's own place in the pane right of the chat (a tab of it when one is open). */
export function splitReviewRow(item: ReviewItem): void {
  nameIt(item)
  openInApp(rowPlace(item), 'split')
}

export interface RowMenuState {
  item: ReviewItem
  x: number
  y: number
}

/**
 * A queue row was opened (ListRow onActivate), by the one click rule: in place on a plain click,
 * Enter or Space; a background tab with Cmd (or a middle click); a split with Cmd+Shift. The
 * context menu offers a new tab or a split.
 */
export function activateReviewRow(item: ReviewItem, e: ClickMods): void {
  const target = navTargetOf(e)
  if (target === 'split') splitReviewRow(item)
  else if (target === 'background') {
    nameIt(item)
    openInApp(rowPlace(item), 'background')
  } else openReviewRow(item, false)
}

/** The one menu of the queue: open the row's item in a new tab or a split pane. */
export function ReviewRowMenu({
  menu,
  onClose,
}: {
  menu: RowMenuState | null
  onClose: () => void
}) {
  return createPortal(
    <EvaMenu
      opened={menu !== null}
      onChange={(o) => {
        if (!o) onClose()
      }}
      width={220}
      position="bottom-start"
      offset={0}
    >
      <EvaMenu.Target>
        <span
          className="eva-cl-menu-anchor"
          style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
          aria-hidden
        />
      </EvaMenu.Target>
      <EvaMenu.Dropdown data-testid="review-row-menu">
        {menu ? (
          <>
            <EvaMenu.Item
              data-testid="review-row-menu-tab"
              leftSection={<IconPlus size={16} stroke={1.5} />}
              onClick={() => openReviewRow(menu.item, true)}
            >
              Open in new tab
            </EvaMenu.Item>
            <EvaMenu.Item
              data-testid="review-row-menu-split"
              leftSection={<IconLayoutColumns size={16} stroke={1.5} />}
              onClick={() => splitReviewRow(menu.item)}
            >
              Open in split pane
            </EvaMenu.Item>
            <EvaMenu.Item
              data-testid="review-row-menu-link"
              leftSection={<IconExternalLink size={16} stroke={1.5} />}
              onClick={() => openLink(menu.item.row.url, { reviews: false })}
            >
              Open in browser
            </EvaMenu.Item>
          </>
        ) : null}
      </EvaMenu.Dropdown>
    </EvaMenu>,
    document.body,
  )
}
