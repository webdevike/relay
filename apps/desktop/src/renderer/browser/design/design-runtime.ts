import { notifications } from '@mantine/notifications'
import { createActor, fromPromise, type ActorRefFrom } from 'xstate'
import { invoke, on } from '../../ipc'
import { frontChatPaneOf } from '../../chat/front-chat'
import { browserStore } from '../browser-store'
import { designModeMachine, type DesignDraft } from './design-mode.machine'
import { buildDesignPrompt } from './design-request'

export type DesignActor = ActorRefFrom<typeof designModeMachine>

/**
 * One design-mode actor per page tab, for the app's lifetime: the mode survives its panel
 * remounting (a pane split, a tab dragged), and main's events reach it whether or not the page
 * is on screen. The machine's effects are IPC to main (design.*) and the chat's `chat.send`.
 */
const actors = new Map<string, DesignActor>()
let listening = false

const machine = designModeMachine.provide({
  actors: {
    setMode: fromPromise<void, { tabId: string; on: boolean }>(async ({ input }) => {
      const r = await invoke('design.set', input)
      if (r.ok) return
      // Turning on failed: the inspector never shows, so say why where Isaac looks.
      if (input.on) notifications.show({ color: 'red', message: r.error.message, autoClose: 6000 })
      throw new Error(r.error.message)
    }),
    sendRequest: fromPromise<void, DesignDraft & { tabId: string }>(async ({ input }) => {
      // The chat of the workspace on screen: the page's own, since its tab is the one in front.
      const paneId = frontChatPaneOf()
      if (!paneId) throw new Error('Open a chat in this workspace to send the change')
      const tab = browserStore.getState().byId[input.tabId]
      const prompt = buildDesignPrompt(input, { url: tab?.url ?? '', title: tab?.title ?? '' })
      const r = await invoke('chat.send', {
        paneId,
        text: prompt.text,
        ...(prompt.images.length > 0 ? { images: prompt.images } : {}),
      })
      if (!r.ok) throw new Error(r.error.message)
    }),
  },
  actions: {
    // The page's answer to a preview: shown (a Send waiting on it may go), or refused (the
    // element went, the session ended): dropped from the request and the inspector says why.
    previewStyle: ({ self }, p) => {
      void invoke('design.style', p).then((r) => {
        self.send(
          r.ok
            ? { type: 'style.previewed' }
            : { type: 'style.rejected', ...p, message: r.error.message },
        )
      })
    },
    // A removal the page refused: the selection stays as it was, a toast says why.
    selectInPage: (_, p) => {
      void invoke('design.select', p).then((r) => {
        if (!r.ok) notifications.show({ color: 'red', message: r.error.message, autoClose: 6000 })
      })
    },
  },
})

function listen(): void {
  if (listening) return
  listening = true
  on('design.selection', (p) =>
    actors.get(p.tabId)?.send({ type: 'page.selection', items: p.items }),
  )
  on('design.exit', (p) => {
    const actor = actors.get(p.tabId)
    if (!actor) return
    if (p.reason === 'escape') return actor.send({ type: 'design.exit' })
    actor.send({ type: 'page.left' })
    // A closed page (any scope; main sends this for every one) takes its actor with it.
    if (p.reason === 'closed') {
      actor.stop()
      actors.delete(p.tabId)
    }
  })
}

/** The design-mode actor of page `tabId`, made on first use. */
export function designActorOf(tabId: string): DesignActor {
  listen()
  let actor = actors.get(tabId)
  if (!actor) {
    actor = createActor(machine, { input: { tabId } }).start()
    actors.set(tabId, actor)
  }
  return actor
}
