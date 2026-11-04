// The renderer half of agent access: describe (what is on screen, in words), typed settings with
// a toast and Undo for every agent change, opening relay:// links, and the tour spotlight.
import { Button, Group, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  AGENT_SETTING_KEYS,
  THEME_COLOR_SCHEMES,
  THEME_PRIMARY_COLORS,
  agentSettings,
  appLinkFor,
  parseSettingValue,
  type AgentParams,
  type AgentRunners,
  type AgentSettingKey,
  type AgentSettingValue,
} from '@evaos/contract'
import { activeTab, appPanelId, type Place } from '@evaos/shell-core'
import type { ThemeConfig } from '@relay/widget-runtime/theme'
import { activePlace, tabsStore } from '../tabs/tabs-store'
import { tabTitle } from '../tabs/tab-meta'
import { paneTabTitle } from '../tiling/pane-tab-meta'
import { tilingStore, toolTabOfId, visiblePanes } from '../tiling/tiling-store'
import { agentTitle } from '../eva/names-store'
import { reviewsStore } from '../reviews/reviews-store'
import { currentSpace, filesStore } from '../files/files-store'
import { browserStore } from '../browser/browser-store'
import {
  allThemes,
  applyPreset,
  setColorScheme,
  themeStore,
  updateConfig,
} from '../theme/theme-config'
import { setHarness, setSetting, settingsStore, startSettings } from '../settings/settings-store'
import { settingTarget } from '../settings/setting-targets'
import { openAppLink } from '../navigation/open-link'
import { clearSpotlight, labelOf, showSpotlight } from '../tour/tour-store'

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

/** Who acts: an assistant's thread scope (`agent:nova`) is that assistant, anything else Eva. */
export function actorOf(scope: string | undefined): string {
  const id = scope?.startsWith('agent:') ? scope.slice('agent:'.length) : null
  if (!id) return 'Eva'
  return agentTitle(id) ?? `${id[0]!.toUpperCase()}${id.slice(1)}`
}

/** A toast for something an agent changed, with Undo when it can be taken back. */
export function announceChange(text: string, undo?: { id: string; run: () => void }): void {
  const id = undo ? `agent-change-${undo.id}` : `agent-change-${Date.now()}`
  notifications.show({
    id,
    autoClose: 12_000,
    withCloseButton: true,
    message: (
      <Group gap="xs" wrap="nowrap" data-testid="agent-change-toast">
        <Text size="sm">{text}</Text>
        {undo ? (
          <>
            <Text size="sm" c="dimmed" aria-hidden>
              ·
            </Text>
            <Button
              size="compact-xs"
              variant="subtle"
              data-testid="agent-change-undo"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                notifications.hide(id)
                undo.run()
              }}
            >
              Undo
            </Button>
          </>
        ) : null}
      </Group>
    ),
  })
}

// ---------------------------------------------------------------------------------------------
// Settings

type ColorKey = Extract<AgentSettingKey, `theme.colors.${string}`>

const colorSlot = (key: ColorKey): [scheme: 'light' | 'dark', slot: string] => {
  const [, , scheme, slot] = key.split('.')
  return [scheme as 'light' | 'dark', slot!]
}

function currentValue(key: AgentSettingKey): unknown {
  const t = themeStore.getState()
  const c = t.present
  const s = settingsStore.getState()
  switch (key) {
    case 'theme.mode':
      return t.colorScheme
    case 'theme.preset':
      return t.preset
    case 'theme.primaryColor':
      return c.primaryColor
    case 'theme.radius':
      return c.defaultRadius
    case 'theme.scale':
      return c.scale
    case 'theme.fontFamily':
      return c.fontFamily
    case 'chat.showThinking':
      return s.show_thinking
    case 'chat.showTools':
      return s.show_tools
    case 'chat.harness':
      return s.harness
    default: {
      const [scheme, slot] = colorSlot(key)
      return c.semantic[scheme][slot as keyof ThemeConfig['semantic']['light']]
    }
  }
}

/** A theme's value from its value or its name ("Ocean"), else not-found listing them. */
function themeValue(nameOrValue: string): { value: string; label: string } {
  const themes = allThemes(themeStore.getState().themes)
  const want = nameOrValue.trim().toLowerCase()
  const hit = themes.find((t) => t.value === want || t.label.toLowerCase() === want)
  if (!hit) {
    fail(
      'not-found',
      `No theme ${nameOrValue}; themes: ${themes.map((t) => `${t.label} (${t.value})`).join(', ')}`,
    )
  }
  return { value: hit.value, label: hit.label }
}

/** How a value reads in the toast: a theme's name, on/off, the value itself. */
function shown(key: AgentSettingKey, value: unknown): string {
  if (key === 'theme.preset') {
    return (
      allThemes(themeStore.getState().themes).find((t) => t.value === value)?.label ?? String(value)
    )
  }
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  return String(value)
}

async function applyValue(key: AgentSettingKey, value: unknown): Promise<void> {
  switch (key) {
    case 'theme.mode':
      setColorScheme(value as 'light' | 'dark')
      return
    case 'theme.preset':
      applyPreset(value as string)
      return
    case 'theme.primaryColor':
      updateConfig((c) => ({ ...c, primaryColor: value as string }))
      return
    case 'theme.radius':
      updateConfig((c) => ({ ...c, defaultRadius: value as ThemeConfig['defaultRadius'] }))
      return
    case 'theme.scale':
      updateConfig((c) => ({ ...c, scale: value as number }))
      return
    case 'theme.fontFamily':
      updateConfig((c) => ({ ...c, fontFamily: value as string }))
      return
    case 'chat.showThinking':
      await setSetting('show_thinking', value as boolean)
      return
    case 'chat.showTools':
      await setSetting('show_tools', value as boolean)
      return
    case 'chat.harness':
      await setHarness(value as 'omp' | 'claude')
      return
    default: {
      const [scheme, slot] = colorSlot(key)
      updateConfig((c) => ({
        ...c,
        semantic: { ...c.semantic, [scheme]: { ...c.semantic[scheme], [slot]: value } },
      }))
    }
  }
}

interface Change {
  id: string
  key: AgentSettingKey
  previous: unknown
  actor: string
}

/** Agent changes not undone yet, newest last. */
const changes: Change[] = []
let changeSeq = 0

function noun(key: AgentSettingKey): string {
  return agentSettings[key].title.toLowerCase()
}

async function undoChange(
  c: Change,
  by: string,
): Promise<{ key: AgentSettingKey; value: unknown }> {
  const at = changes.indexOf(c)
  if (at >= 0) changes.splice(at, 1)
  await applyValue(c.key, c.previous)
  notifications.show({
    autoClose: 6000,
    message: `${by} put ${noun(c.key)} back to ${shown(c.key, c.previous)}`,
  })
  return { key: c.key, value: c.previous }
}

function optionsOf(key: AgentSettingKey): readonly string[] | undefined {
  if (key === 'theme.mode') return THEME_COLOR_SCHEMES
  if (key === 'theme.preset') {
    return allThemes(themeStore.getState().themes).map((t) => `${t.value} (${t.label})`)
  }
  if (key === 'theme.primaryColor') return THEME_PRIMARY_COLORS
  if (key === 'theme.radius') return ['xs', 'sm', 'md', 'lg', 'xl']
  if (key === 'chat.harness') return ['omp', 'claude']
  return undefined
}

/** settings.get (exported for tests: the runner map types answers as unknown). */
export async function readSettings(
  p: AgentParams<'settings.get'>,
): Promise<{ settings: AgentSettingValue[] }> {
  await startSettings()
  const keys = AGENT_SETTING_KEYS.filter(
    (k) =>
      (p.key === undefined || k === p.key) &&
      (p.section === undefined || agentSettings[k].section === p.section),
  )
  return {
    settings: keys.map((key) => {
      const options = optionsOf(key)
      return {
        key,
        title: agentSettings[key].title,
        section: agentSettings[key].section,
        value: currentValue(key),
        ...(options ? { options } : {}),
        link: appLinkFor({ setting: key }).url,
      }
    }),
  }
}

/** settings.set (exported for tests). */
export async function writeSetting(p: AgentParams<'settings.set'>) {
  await startSettings()
  const key = p.key as AgentSettingKey
  const parsed = parseSettingValue(key, p.value)
  if (!parsed.ok) fail('invalid-params', parsed.message)
  const value = key === 'theme.preset' ? themeValue(parsed.value as string).value : parsed.value
  const previous = currentValue(key)
  if (JSON.stringify(previous) === JSON.stringify(value)) {
    return { key, value, previous, changed: false }
  }
  await applyValue(key, value)
  const actor = actorOf(p.scope)
  const change: Change = { id: `c${++changeSeq}`, key, previous, actor }
  changes.push(change)
  announceChange(`${actor} changed ${noun(key)} to ${shown(key, value)}`, {
    id: change.id,
    run: () => void undoChange(change, 'You'),
  })
  return {
    key,
    value,
    previous,
    changed: true,
    changeId: change.id,
    target: settingTarget(key),
    undo: `settings.undo {"changeId":"${change.id}"}`,
  }
}

// ---------------------------------------------------------------------------------------------
// describe

/** A place's deep link, or null for one that has none (a single chat, a review item). */
function placeLink(p: Place): string | null {
  try {
    if (p.page === 'settings')
      return appLinkFor({ page: 'settings', section: p.settingsSection }).url
    if (p.page === 'canvas' && p.canvas) return appLinkFor({ page: 'canvas', canvas: p.canvas }).url
    if (p.page.startsWith('review:')) return null
    return appLinkFor({ page: p.page as AgentParams<'link'>['page'] }).url
  } catch {
    return null
  }
}

/** Controls on screen a tour can point at: tagged ones first, then labelled buttons and fields. */
function controlsOnScreen(): Array<{ target: string; label: string; kind: string }> {
  const seen = new Set<string>()
  const out: Array<{ target: string; label: string; kind: string }> = []
  const els = document.querySelectorAll<HTMLElement>(
    '[data-tour], button[data-testid], a[data-testid], input[data-testid], [role=tab][data-testid], [role=button][data-testid], [data-testid^="nav-"], [data-testid^="settings-item-"]',
  )
  for (const el of els) {
    const target = el.getAttribute('data-tour') ?? el.getAttribute('data-testid')
    if (!target || seen.has(target)) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > window.innerHeight) continue
    const label = labelOf(el)
    if (!label && !el.hasAttribute('data-tour')) continue
    seen.add(target)
    out.push({
      target,
      label,
      kind:
        el.tagName === 'INPUT' ? 'field' : (el.getAttribute('role') ?? el.tagName.toLowerCase()),
    })
    if (out.length >= 80) break
  }
  return out
}

function selectedReviewUrl(): string | null {
  const s = reviewsStore.getState()
  return s.selected?.url ?? s.ticket?.url ?? s.thread?.url ?? null
}

export function describeScreen(): Record<string, unknown> {
  const here = activePlace(tabsStore.getState())
  const tabs = tabsStore.getState().tabs
  const tiling = tilingStore.getState()
  const space = currentSpace(filesStore.getState())
  const review = here.page === 'reviews' ? selectedReviewUrl() : null
  const theme = themeStore.getState()
  const themeLabel =
    allThemes(theme.themes).find((t) => t.value === theme.preset)?.label ?? theme.preset
  const page = {
    key: here.page,
    title: tabTitle(here),
    section: here.page === 'settings' ? here.settingsSection : null,
    chat: here.page === 'chat' && here.chat !== 'draft' ? here.chat : null,
    canvas: here.canvas,
    reviewItem: review,
    link: placeLink(here),
  }
  const front = appPanelId(activeTab(tabs).id)
  const panes = visiblePanes(tiling).map((p) => {
    const titles = p.views.map((v) => {
      if (v === front || v.startsWith('tab:'))
        return tabTitle(tabs.list.find((t) => appPanelId(t.id) === v)?.here ?? here)
      const tool = toolTabOfId(v)
      return tool ? paneTabTitle(tool) : v
    })
    const at = p.active === null ? -1 : p.views.indexOf(p.active)
    return {
      pane: p.id,
      focused: tiling.focus === p.id,
      front: at >= 0 ? titles[at] : null,
      tabs: titles,
    }
  })
  const browser = browserStore.getState()
  const activeBrowser = browser.tabs.find((t) => t.id === browser.activeId) ?? null
  const selected = {
    ...(review ? { reviewItem: review } : {}),
    ...(space?.selected ? { file: space.selected } : {}),
    ...(activeBrowser
      ? { browserTab: { title: activeBrowser.title, url: activeBrowser.url } }
      : {}),
    theme: { preset: themeLabel, mode: theme.colorScheme },
  }
  const controls = controlsOnScreen()
  const lines = [
    `Page: ${page.title}${page.link ? ` (${page.link})` : ''}`,
    ...(review ? [`Reviews item: ${review}`] : []),
    `Theme: ${themeLabel}, ${theme.colorScheme}`,
    `Panes: ${panes.map((p) => `${p.pane}${p.focused ? ' (focused)' : ''}: ${p.front ?? 'empty'}${p.tabs.length > 1 ? ` [${p.tabs.join(', ')}]` : ''}`).join('; ')}`,
    ...(activeBrowser ? [`Browser: ${activeBrowser.title} ${activeBrowser.url}`] : []),
    ...(space?.selected ? [`Files: ${space.selected}`] : []),
    `Window: ${document.hasFocus() ? 'in front' : 'in the background'}`,
    `Controls: ${controls
      .slice(0, 25)
      .map((c) => `${c.label || c.target} [${c.target}]`)
      .join(', ')}`,
  ]
  return {
    text: lines.join('\n'),
    page,
    selected,
    panes,
    controls,
    windowFocused: document.hasFocus(),
  }
}

// ---------------------------------------------------------------------------------------------

export const accessActions: Pick<
  AgentRunners<'renderer'>,
  | 'describe'
  | 'settings.get'
  | 'settings.set'
  | 'settings.undo'
  | 'link.open'
  | 'tour.highlight'
  | 'tour.clear'
> = {
  describe: () => describeScreen(),
  'settings.get': (p) => readSettings(p),
  'settings.set': (p) => writeSetting(p),
  'settings.undo': async ({ changeId, scope }) => {
    const c = changeId === undefined ? changes.at(-1) : changes.find((x) => x.id === changeId)
    if (!c)
      fail('not-found', changeId ? `No change ${changeId} to undo` : 'No agent change to undo')
    notifications.hide(`agent-change-${c.id}`)
    return { undone: c.id, ...(await undoChange(c, actorOf(scope))) }
  },
  'link.open': ({ url, target }) => {
    if (!openAppLink(url, target ?? 'here')) fail('not-found', `Nothing in this app opens ${url}`)
    return { opened: url, target: target ?? 'here' }
  },
  'tour.highlight': ({ target, caption, title, step, ms }) =>
    showSpotlight({
      target,
      caption,
      ...(title === undefined ? {} : { title }),
      ...(step === undefined ? {} : { step }),
      ...(ms === undefined ? {} : { ms }),
    }),
  'tour.clear': () => {
    clearSpotlight()
    return { cleared: true }
  },
}
