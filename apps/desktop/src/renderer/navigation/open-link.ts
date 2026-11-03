import { resolveLink } from '@evaos/contract'
import { parseAppLink } from '@evaos/chat-core/widget'
import { isChatPane, pageFromKey, placeOf, type Place } from '@evaos/shell-core'
import { invoke } from '../ipc'
import { openReviewItem } from '../reviews/reviews-store'
import { navigateTo } from '../tabs/tabs-store'
import { openTab, revealTool, splitAt, tilingStore } from '../tiling/tiling-store'
import { linkPrefsStore } from './link-prefs'
import { openPlace } from './navigate'

export interface OpenLinkOptions {
  /** Cmd+click: an in-app place (Reviews) opens in a new pane beside the focused one. */
  newPane?: boolean
  /** False skips the Reviews rules: Reviews' own "Open in Linear" buttons leave Relay. */
  reviews?: boolean
}

/**
 * Opens a link. `relay://assistant/<id>` and `relay://open/<page>` are in-app places (never the
 * browser; Cmd opens a new tab). A web link goes where Settings > Links says: an item in Reviews
 * (the focused pane's tab, or a new pane), a new tab of the current scope's browser, or (an app, a
 * URL scheme, the default browser) through main. Other schemes go nowhere.
 */
export function openLink(href: string, opts: OpenLinkOptions = {}): void {
  if (href.startsWith('relay://')) {
    const place = appLinkPlace(href)
    if (place !== null) openPlace(place, { newTab: opts.newPane === true })
    return
  }
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

/** The place a `relay://` link names, or null for one this app can't open. */
function appLinkPlace(href: string): Place | null {
  const link = parseAppLink(href)
  if (link === null) return null
  if (link.kind === 'assistant') return placeOf(`agent:${link.id}`)
  const page = pageFromKey(link.page)
  return page === null ? null : placeOf(page)
}
