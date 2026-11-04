// Tells main when Isaac uses the window and which page is in front, so agents on the Mini's Relay
// Host act on the Mac he is using (main/agent-control/remote.ts). Input goes out at most once a
// second; main stamps the time, the host compares Macs on its own clock.
import { invoke } from '../ipc'
import { activePlace, tabsStore } from '../tabs/tabs-store'

const INPUT_EVERY_MS = 1000
const INPUT_EVENTS = ['keydown', 'pointerdown', 'wheel'] as const

export function startPresence(): () => void {
  let page: string = activePlace(tabsStore.getState()).page
  let sentAt = 0
  const send = (input: boolean): void => void invoke('agent.presence', { page, input })
  const onInput = (): void => {
    const now = Date.now()
    if (now - sentAt < INPUT_EVERY_MS) return
    sentAt = now
    send(true)
  }
  const offPage = tabsStore.subscribe((s) => {
    const next = activePlace(s).page
    if (next === page) return
    page = next
    send(false)
  })
  send(false)
  for (const e of INPUT_EVENTS)
    window.addEventListener(e, onInput, { capture: true, passive: true })
  return () => {
    offPage()
    for (const e of INPUT_EVENTS) window.removeEventListener(e, onInput, { capture: true })
  }
}
