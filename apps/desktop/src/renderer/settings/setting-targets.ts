import { agentSettings, isAgentSettingKey, type AgentSettingKey } from '@evaos/contract'
import { findTarget, showSpotlight } from '../tour/tour-store'

/** The control on its Settings section that changes a setting (a tour target). */
export function settingTarget(key: AgentSettingKey): string {
  if (key === 'theme.mode') return 'theme-color-scheme'
  if (key === 'theme.preset') return 'theme-preset-picker'
  if (key === 'chat.showThinking') return 'settings-show-thinking'
  if (key === 'chat.showTools') return 'settings-show-tools'
  if (key === 'chat.harness') return 'settings-harness'
  // Colors, fonts, radius and scale live in the theme editor's property column.
  return 'theme-properties'
}

const WAIT_MS = 3000

/**
 * Points out a setting's control once its section has drawn (a deep link's `?setting=`), with the
 * setting's name and what it does. Unknown keys and a control that never shows are ignored.
 */
export function pointAtSetting(key: string): void {
  if (!isAgentSettingKey(key)) return
  const target = settingTarget(key)
  const until = Date.now() + WAIT_MS
  const tryShow = (): void => {
    if (findTarget(target) !== null) {
      const spec = agentSettings[key]
      showSpotlight({ target, title: spec.title, caption: spec.description })
    } else if (Date.now() < until) {
      setTimeout(tryShow, 100)
    }
  }
  setTimeout(tryShow, 0)
}
