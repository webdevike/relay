import { notifications } from '@mantine/notifications'
import { resolveLink, settingsSectionOf } from '@evaos/contract'
import { parseAppLink, type AppLink } from '@evaos/chat-core/widget'
import { pageFromKey, placeOf, type Place } from '@evaos/shell-core'
import { invoke } from '../ipc'
import { openReviewItem } from '../reviews/reviews-store'
import { openArmTab, revealTool } from '../tiling/tiling-store'
import { requestExperiment } from '../test-bench/bench-request'
import { requestSkill } from '../skills/skill-request'
import { requestStudioOpen } from '../studio/studio-store'
import { pointAtSetting } from '../settings/setting-targets'
import { focusConnection } from '../settings/connections-store'
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
 * Opens a link. `relay://assistant/<id>` and `relay://open/...` are in-app places (never the
 * browser) and open per `target`. A web link goes where Settings > Links says: an item in Reviews
 * (in-app, per `target`), a new tab of the current scope's browser, or (an app, a URL scheme, the
 * default browser) through main. Other schemes go nowhere.
 */
export function openLink(href: string, opts: OpenLinkOptions = {}): void {
  if (href.startsWith('relay://')) {
    if (!openAppLink(href, opts.target)) {
      notifications.show({ message: 'Relay has no place for that link.', color: 'yellow' })
    }
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

/**
 * Opens a `relay://` link: the place it names per `target`, then what it shows there (a Reviews
 * item, a Test Bench run and arm, a Skills row, a Studio job, a setting's control pointed out, a
 * connection's Connect step). False when it names nothing this app opens.
 */
export function openAppLink(href: string, target?: OpenTarget): boolean {
  const link = parseAppLink(href)
  const place = link === null ? null : appLinkPlace(link)
  if (link === null || place === null) return false
  if (link.kind === 'open' && link.params?.experiment !== undefined) {
    requestExperiment(link.params.experiment)
  }
  if (link.kind === 'open' && link.params?.skill !== undefined && link.page === 'skills') {
    requestSkill(link.params.skill)
  }
  openInApp(place, target)
  if (link.kind === 'assistant') return true
  const { item, job, setting, connect, experiment, arm } = link.params ?? {}
  if (item !== undefined) openReviewItem(item)
  if (job !== undefined) requestStudioOpen({ job })
  if (experiment !== undefined && arm !== undefined) openArmTab({ experiment, arm, label: arm })
  if (connect !== undefined) focusConnection(connect)
  if (setting !== undefined) pointAtSetting(setting)
  return true
}

/** The place a `relay://` link names, or null for one this app can't open. */
export function appLinkPlace(link: AppLink): Place | null {
  if (link.kind === 'assistant') return placeOf(`agent:${link.id}`)
  const params = link.params ?? {}
  if (link.page === 'workspace' || link.page === 'board') {
    return link.sub === undefined ? null : placeOf(`${link.page}:${link.sub}`)
  }
  const page = pageFromKey(link.page)
  if (page === null) return null
  if (page === 'settings') {
    const section = link.sub === undefined ? 'Theme' : settingsSectionOf(link.sub)
    return section === null ? null : placeOf('settings', { settingsSection: section })
  }
  if (link.sub !== undefined) return null
  return placeOf(page, {
    ...(page === 'canvas' && params.canvas !== undefined ? { canvas: params.canvas } : {}),
    ...(page === 'meetings' && params.meeting !== undefined ? { meeting: params.meeting } : {}),
  })
}
