import { notifications } from '@mantine/notifications'
import { resolveLink, settingsSectionOf } from '@evaos/contract'
import { parseAppLink, type AppLink } from '@evaos/chat-core/widget'
import { pageFromKey, placeOf, type Place } from '@evaos/shell-core'
import { draftToAssistant, sendToAssistant } from '../assistants/assistant-send'
import { invoke } from '../ipc'
import { openReviewItem } from '../reviews/reviews-store'
import { reviewPlaceOf, reviewRefOfId } from '../reviews/review-place'
import { openArmTab, revealTool, splitAt, tilingStore } from '../tiling/tiling-store'
import { openWebPage } from '../tiling/web-tabs'
import { requestExperiment } from '../test-bench/bench-request'
import { requestSkill } from '../skills/skill-request'
import { openAgent } from '../specialists/specialists-store'
import { requestStudioOpen } from '../studio/studio-store'
import { pointAtSetting } from '../settings/setting-targets'
import { focusConnection } from '../settings/connections-store'
import { showPath } from '../files/files-store'
import { chatStore } from '../chat/chat-store'
import { frontChatPaneOf } from '../chat/front-chat'
import { linkPrefsStore } from './link-prefs'
import { inBackground, openInApp } from './open-in-app'
import type { OpenTarget } from './open-target'
import { parseAddress, placeOfAddress, type TabAddress } from './tab-address'

export interface OpenLinkOptions {
  /** Where it opens (default: here, in this workspace, focused). */
  target?: OpenTarget
  /** False skips the Reviews rules: Reviews' own "Open in Linear" buttons leave Relay. */
  reviews?: boolean
  /** Isaac's click opened it (default: a click is live in this window), so a
   * `relay://assistant/<id>?send=` link may send; without one it only drafts. */
  gesture?: boolean
}

const isWeb = (href: string): boolean => /^https?:\/\//i.test(href)

/**
 * Opens a link. A `relay://` address opens in the app per `target`. A web link goes where
 * Settings > Links says: an item in Reviews (in-app, per `target`), a page tab of this workspace
 * (per `target`), or (an app, a URL scheme, the default browser) through main. `external`
 * (Option+click) opens a web link in Arc. Other schemes go nowhere.
 */
export function openLink(href: string, opts: OpenLinkOptions = {}): void {
  const target = opts.target ?? 'here'
  if (href.startsWith('relay://')) {
    const gesture = opts.gesture ?? navigator.userActivation?.isActive ?? false
    if (!openAppLink(href, target, gesture)) {
      notifications.show({ message: 'Relay has no place for that link.', color: 'yellow' })
    }
    return
  }
  if (target === 'external') {
    if (isWeb(href)) void invoke('links.openInArc', { url: new URL(href).href })
    return
  }
  const { prefs, apps } = linkPrefsStore.getState()
  const route = resolveLink(prefs, href, (app) => apps.includes(app), { reviews: opts.reviews })
  if (route.to === 'none') return
  if (route.to === 'reviews') {
    openInApp(placeOf('reviews'), target)
    openReviewItem(route.url)
    return
  }
  if (route.to === 'browser') {
    openWeb(route.url, target)
    return
  }
  void invoke('links.open', {
    url: new URL(href).href,
    ...(opts.reviews === false ? { reviews: false } : {}),
  })
}

/** A web page as a page tab of this workspace: here (focused), in the background or a split. */
function openWeb(url: string, target: OpenTarget): void {
  if (target === 'external') {
    void invoke('links.openInArc', { url })
    return
  }
  void openWebPage({
    url,
    ...(target === 'background' ? { background: true } : {}),
    ...(target === 'split' ? { split: 'right' as const } : {}),
  }).catch(() => {
    notifications.show({ message: 'Relay could not open that page.', color: 'yellow' })
  })
}

const frontChatFile = (): string | null =>
  chatStore.getState().panes[frontChatPaneOf()]?.file || null

/**
 * A file in the Files tab (at `line`, lines `line`-`end` selected): here, in the background, or in
 * a Files tab split off the focused pane.
 */
function openFileAt(path: string, at: { line?: number; end?: number }, target: OpenTarget): void {
  const show = (): void => {
    const focus = tilingStore.getState().focus
    if (target === 'split' && focus !== null) splitAt(focus, 'right', { kind: 'files' })
    else revealTool('files')
  }
  if (target === 'background') inBackground(show)
  else show()
  const opts =
    at.line === undefined
      ? {}
      : { line: at.line, ...(at.end === undefined ? {} : { endLine: at.end }) }
  void showPath(path, frontChatFile(), opts).catch(() => {
    notifications.show({ message: `Relay could not open ${path}.`, color: 'yellow' })
  })
}

/**
 * Opens a `relay://` address per `target`: the tab it names (a chat, a web page, a file, a board,
 * a Studio job, a Reviews item) or the place an older link names, then what it shows there (a
 * Test Bench run and arm, a Skills row, a setting pointed out, a connection's Connect step). An
 * assistant link's `send` goes out as Isaac's turn in that thread only when his click opened it
 * (`gesture`); otherwise it, like `draft`, waits in the thread's composer. Agents, notifications
 * and links from other apps open without one. False when it names nothing this app opens.
 */
export function openAppLink(href: string, target: OpenTarget = 'here', gesture = false): boolean {
  const address = parseAddress(href)
  if (address === null) return false
  const opened = openAddress(address, target)
  const link = address.kind === 'assistant' ? parseAppLink(href) : null
  if (link?.kind !== 'assistant') return opened
  if (link.send !== undefined && gesture) {
    void sendToAssistant(link.id, link.send).then((failed) => {
      if (failed !== null) notifications.show({ message: failed, color: 'red', autoClose: 6000 })
    })
  } else {
    const words = link.send ?? link.draft
    if (words !== undefined) draftToAssistant(link.id, words)
  }
  return opened
}

export function openAddress(a: TabAddress, target: OpenTarget = 'here'): boolean {
  switch (a.kind) {
    case 'web':
      openWeb(a.url, target)
      return true
    case 'file':
      openFileAt(a.path, { line: a.line, end: a.end }, target)
      return true
    case 'review': {
      const ref = reviewRefOfId(a.item)
      if (ref !== null) {
        openInApp(reviewPlaceOf(ref), target)
        return true
      }
      if (!isWeb(a.item)) return false
      openInApp(placeOf('reviews'), target)
      openReviewItem(a.item)
      return true
    }
    case 'studio':
      openInApp(placeOfAddress(a)!, target)
      requestStudioOpen({ job: a.job })
      return true
    case 'page':
      return openPageLink(a.link, target)
    default:
      openInApp(placeOfAddress(a)!, target)
      return true
  }
}

function openPageLink(link: Extract<AppLink, { kind: 'open' }>, target: OpenTarget): boolean {
  const place = appLinkPlace(link)
  if (place === null) return false
  const { item, job, setting, connect, experiment, arm, skill, agent } = link.params ?? {}
  if (experiment !== undefined) requestExperiment(experiment)
  if (skill !== undefined && link.page === 'skills') requestSkill(skill)
  if (agent !== undefined && link.page === 'agents') openAgent(agent)
  openInApp(place, target)
  if (item !== undefined) openReviewItem(item)
  if (job !== undefined) requestStudioOpen({ job })
  if (experiment !== undefined && arm !== undefined) openArmTab({ experiment, arm, label: arm })
  if (connect !== undefined) focusConnection(connect)
  if (setting !== undefined) pointAtSetting(setting)
  return true
}

/** The place a `relay://` link names, or null for one this app can't open as a place. */
export function appLinkPlace(link: AppLink): Place | null {
  if (link.kind === 'assistant') return placeOf(`agent:${link.id}`)
  const params = link.params ?? {}
  // `board/<slug>` is a dashboard board; a bare `board` is the Board page (the agents' work).
  if (link.page === 'workspace' || link.page === 'board' || link.page === 'room') {
    if (link.sub !== undefined) return placeOf(`${link.page}:${link.sub}`)
    if (link.page !== 'board') return null
  }
  const page = pageFromKey(link.page)
  if (page === null) return null
  if (page === 'settings') {
    const section = link.sub === undefined ? 'Theme' : settingsSectionOf(link.sub)
    return section === null ? null : placeOf('settings', { settingsSection: section })
  }
  if (link.sub !== undefined) return null
  return placeOf(page, {
    ...(page === 'chat' && params.chat !== undefined ? { chat: params.chat } : {}),
    ...(page === 'canvas' && params.canvas !== undefined ? { canvas: params.canvas } : {}),
    ...(page === 'meetings' && params.meeting !== undefined ? { meeting: params.meeting } : {}),
  })
}
