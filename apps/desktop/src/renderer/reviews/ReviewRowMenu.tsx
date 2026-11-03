import { createPortal } from 'react-dom'
import { IconExternalLink, IconLayoutColumns, IconPlus } from '@tabler/icons-react'
import { setReviewTitle } from '../eva/names-store'
import { openPlace } from '../navigation/navigate'
import { openInApp } from '../navigation/open-in-app'
import { openLink } from '../navigation/open-link'
import { navTargetOf, type ClickMods } from '../navigation/open-target'
import { EvaMenu } from '../overlay'
import { activePlace, tabsStore } from '../tabs/tabs-store'
import { reviewIdOf, reviewPlaceOf, reviewRefOf, reviewTitleOf } from './review-place'
import { openPr, openThread, openTicket, type ReviewItem } from './reviews-store'

/** Remembers the item's title, so the tab it opens is named at once (and after a restart). */
function nameIt(item: ReviewItem): void {
  setReviewTitle(reviewIdOf(reviewRefOf(item)), reviewTitleOf(item))
}

/**
 * Opens a queue row. On the Reviews page a plain click shows it there (as before); anywhere else
 * (a chat, another review) it goes to the item's own place in this tab, and `newTab` (Cmd+Shift-click,
 * middle-click, the menu) always opens its own tab, so several can be open at once.
 */
export function openReviewRow(item: ReviewItem, newTab: boolean): void {
  if (!newTab && activePlace(tabsStore.getState()).page === 'reviews') {
    if (item.kind === 'pr') openPr(item.row)
    else if (item.kind === 'linear') openTicket(item.row)
    else openThread(item.row)
    return
  }
  nameIt(item)
  openPlace(reviewPlaceOf(reviewRefOf(item)), { newTab })
}

/** The item's own place in the pane right of the chat (a tab of it when one is open). */
export function splitReviewRow(item: ReviewItem): void {
  nameIt(item)
  openInApp(reviewPlaceOf(reviewRefOf(item)), 'split')
}

export interface RowMenuState {
  item: ReviewItem
  x: number
  y: number
}

/**
 * A queue row was opened (ListRow onActivate): in place on a plain click, Enter or Space; a side
 * pane with Cmd; a new tab with Cmd+Shift or a middle click. The context menu offers both.
 */
export function activateReviewRow(item: ReviewItem, e: ClickMods): void {
  const target = navTargetOf(e)
  if (target === 'split') splitReviewRow(item)
  else openReviewRow(item, target === 'tab')
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
