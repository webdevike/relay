import { resolveLink } from '@evaos/contract'
import { isChatPane, placeOf } from '@evaos/shell-core'
import { invoke } from '../ipc'
import { openReviewItem } from '../reviews/reviews-store'
import { navigateTo } from '../tabs/tabs-store'
import { openTab, revealTool, splitAt, tilingStore } from '../tiling/tiling-store'
import { linkPrefsStore } from './link-prefs'

export interface OpenLinkOptions {
  /** Cmd+click: an in-app place (Reviews) opens in a new pane beside the focused one. */
  newPane?: boolean
  /** False skips the Reviews rules: Reviews' own "Open in Linear" buttons leave Relay. */
  reviews?: boolean
}

/**
 * Opens a web link where Settings > Links says: an item in Reviews (the focused pane's tab, or a
 * new pane), a new tab of the current scope's browser, or (an app, a URL scheme, the default
 * browser) through main. Other schemes go nowhere.
 */
export function openLink(href: string, opts: OpenLinkOptions = {}): void {
  const { prefs, apps } = linkPrefsStore.getState()
  const route = resolveLink(prefs, href, (app) => apps.includes(app), { reviews: opts.reviews })
  if (route.to === 'none') return
  if (route.to === 'reviews') {
    showInReviews(route.url, opts.newPane === true)
    return
  }
  if (route.to === 'browser') {
    revealTool('browser')
    void invoke('browser.createTab', { url: route.url })
    return
  }
  void invoke('links.open', {
    url: new URL(href).href,
    ...(opts.reviews === false ? { reviews: false } : {}),
  })
}

/**
 * The Reviews page with `url`'s item: like other in-app places, in the focused pane (the chat
 * pane's current tab navigates, a tool pane gets a Reviews tab), or with `newPane` a split beside it.
 */
function showInReviews(url: string, newPane: boolean): void {
  const place = placeOf('reviews')
  const focus = tilingStore.getState().tiling.focus
  if (newPane) splitAt(focus, 'right', { kind: 'page', place })
  else if (isChatPane(focus)) navigateTo(place)
  else openTab({ kind: 'page', place }, focus)
  openReviewItem(url)
}
