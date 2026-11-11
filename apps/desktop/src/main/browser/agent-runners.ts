import type { AgentRunners } from '@evaos/contract'
import type { AgentDrive } from './agent-drive'

type DriveActionId =
  | 'browser.tabs'
  | 'browser.read'
  | 'browser.screenshot'
  | 'browser.navigate'
  | 'browser.click'
  | 'browser.type'
  | 'browser.press'
  | 'browser.scroll'
  | 'browser.wait'
  | 'browser.caption'
  | 'browser.done'

/** The agent control API's browser.* drive actions (see agent-drive.ts), run in main. */
export function browserRunners(drive: AgentDrive): Pick<AgentRunners<'main'>, DriveActionId> {
  return {
    'browser.tabs': () => drive.tabs(),
    'browser.read': ({ tabId, mode, selector, maxChars }) =>
      drive.read(tabId, mode, selector, maxChars),
    'browser.screenshot': ({ tabId }) => drive.screenshot(tabId),
    'browser.navigate': ({ tabId, url, go, caption, scope }) =>
      drive.navigate(
        tabId,
        { ...(url !== undefined ? { url } : {}), ...(go ? { go } : {}) },
        caption,
        scope,
      ),
    'browser.click': ({ tabId, ref, selector, text, x, y, intent, caption, scope }) =>
      drive.click(tabId, { ref, selector, text, x, y }, intent, caption, scope),
    'browser.type': ({
      tabId,
      text,
      ref,
      selector,
      label,
      x,
      y,
      clear,
      submit,
      intent,
      caption,
      scope,
    }) =>
      drive.type(
        tabId,
        { ref, selector, text: label, x, y },
        { text, clear, submit },
        intent,
        caption,
        scope,
      ),
    'browser.press': ({ tabId, key, intent, caption, scope }) =>
      drive.press(tabId, key, intent, caption, scope),
    'browser.scroll': ({ tabId, dy, to, ref, selector, text, caption, scope }) =>
      drive.scroll(tabId, { dy, to, ref, selector, text }, caption, scope),
    'browser.wait': ({ tabId, until, value, timeoutMs }) =>
      drive.wait(tabId, until, value, timeoutMs),
    'browser.caption': ({ tabId, text, scope }) => drive.caption(tabId, text, scope),
    'browser.done': ({ tabId, summary, outcome, scope }) =>
      drive.done(tabId, summary, outcome, scope),
  }
}
