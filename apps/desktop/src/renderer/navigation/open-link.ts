import { resolveLink } from '@evaos/contract'
import { parseAppLink } from '@evaos/chat-core/widget'
import { pageFromKey, placeOf, type Place } from '@evaos/shell-core'
import { invoke } from '../ipc'
import { openReviewItem } from '../reviews/reviews-store'
import { revealTool } from '../tiling/tiling-store'
import { linkPrefsStore } from './link-prefs'
import { openInApp } from './open-in-app'
import type { OpenTarget } from './open-target'

export interface OpenLinkOptions {
  /** Where an in-app destination opens (default: a split right of the chat). */
  target?: OpenTarget
  /** False skips the Reviews rules: Reviews' own "Open in Linear" buttons leave Relay. */
  reviews?: boolean
}

/**
 * Opens a link. `relay://assistant/<id>` and `relay://open/<page>` are in-app places (never the
 * browser) and open per `target`. A web link goes where Settings > Links says: an item in Reviews
 * (in-app, per `target`), a new tab of the current scope's browser, or (an app, a URL scheme, the
 * default browser) through main. Other schemes go nowhere.
 */
export function openLink(href: string, opts: OpenLinkOptions = {}): void {
  if (href.startsWith('relay://')) {
    const place = appLinkPlace(href)
    if (place !== null) openInApp(place, opts.target)
    return
  }
  const { prefs, apps } = linkPrefsStore.getState()
  const route = resolveLink(prefs, href, (app) => apps.includes(app), { reviews: opts.reviews })
  if (route.to === 'none') return
  if (route.to === 'reviews') {
    openInApp(placeOf('reviews'), opts.target)
    openReviewItem(route.url)
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

/** The place a `relay://` link names, or null for one this app can't open. */
function appLinkPlace(href: string): Place | null {
  const link = parseAppLink(href)
  if (link === null) return null
  if (link.kind === 'assistant') return placeOf(`agent:${link.id}`)
  const page = pageFromKey(link.page)
  return page === null ? null : placeOf(page)
}
