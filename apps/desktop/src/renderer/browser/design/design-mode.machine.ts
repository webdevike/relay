import { assign, fromPromise, setup } from 'xstate'
import type { DesignItem, DesignStyleEdit, DesignStyleKey } from '@evaos/contract'

/**
 * Design Mode in one page tab (docs/state-machines/design-mode.md): off, turning on, picking
 * elements, one or more selected (the inspector), drawing on a crop, sending the request to the
 * workspace's chat, sent (the selection stays while the page hot-reloads), turning off. Main does
 * the page side (main/browser/design-mode.ts); its `design.selection` and `design.exit` events
 * arrive here as `page.selection`, `design.exit` (Escape) and `page.left` (another site, closed).
 */

/** What one Send carries; main turns it into a page note for the chat (design.send). */
export interface DesignDraft {
  items: DesignItem[]
  instruction: string
  edits: DesignStyleEdit[]
  /** Crops Isaac drew on, by selector: PNG base64 replacing that item's plain crop. */
  drawings: Record<string, string>
}

export interface DesignContext extends DesignDraft {
  tabId: string
  /** The item whose styles the inspector shows. */
  focus: number
  /** The selector whose crop is open for drawing, while `drawing`. */
  drawingOf: string | null
  /** The image drawn on, fixed when drawing opens (a refresh can't swap it mid-stroke). */
  drawingFrom: string | null
  error: string | null
  /** Style previews the page has not answered yet: a Send waits for them (`sendQueued`). */
  previewing: number
  /** Send was pressed while previews were out: it goes once they are answered. */
  sendQueued: boolean
}

export type DesignEvent =
  | { type: 'design.toggle' }
  | { type: 'design.exit' }
  | { type: 'page.left' }
  | { type: 'page.selection'; items: DesignItem[] }
  | { type: 'item.focus'; index: number }
  | { type: 'item.remove'; selector: string }
  | { type: 'instruction.change'; text: string }
  | { type: 'style.edit'; selector: string; property: DesignStyleKey; value: string }
  /** The page showed a preview (main answered `design.style`). */
  | { type: 'style.previewed' }
  /** The page refused a preview (the element is gone): that edit is not kept; `message` says why. */
  | {
      type: 'style.rejected'
      selector: string
      property: DesignStyleKey
      value: string
      message: string
    }
  | { type: 'draw.open'; selector: string }
  | { type: 'draw.done'; png: string }
  | { type: 'draw.cancel' }
  | { type: 'request.send' }
  /** The composer sent the selection with a chat message. */
  | { type: 'request.consumed' }

const cleared = {
  items: [],
  instruction: '',
  edits: [],
  drawings: {},
  focus: 0,
  drawingOf: null,
  drawingFrom: null,
  previewing: 0,
  sendQueued: false,
}

/** True when the request says something: words, or a style edit or drawing of a present item. */
export function hasRequest(c: DesignDraft): boolean {
  const present = c.items.filter((i) => !i.missing).map((i) => i.selector)
  return (
    present.length > 0 &&
    (c.instruction.trim() !== '' ||
      c.edits.some((e) => present.includes(e.selector)) ||
      Object.keys(c.drawings).some((s) => present.includes(s)))
  )
}

export const designModeMachine = setup({
  types: {
    input: {} as { tabId: string },
    context: {} as DesignContext,
    events: {} as DesignEvent,
  },
  actors: {
    // Placeholders: design-runtime.ts provides the IPC, tests provide stubs.
    setMode: fromPromise<void, { tabId: string; on: boolean }>(async () => {
      throw new Error('setMode not provided')
    }),
    sendRequest: fromPromise<void, DesignDraft & { tabId: string }>(async () => {
      throw new Error('sendRequest not provided')
    }),
  },
  actions: {
    /** The page shows the edit at once (an inline style); main answers with a refresh. */
    previewStyle: (
      _,
      _params: { tabId: string; selector: string; property: DesignStyleKey; value: string },
    ) => {},
    /** Main drops the element from the page's selection and answers with the rest. */
    selectInPage: (_, _params: { tabId: string; selectors: string[] }) => {},
    takeSelection: assign(({ context }, params: { items: DesignItem[] }) => {
      const keep = new Set(params.items.map((i) => i.selector))
      const drawings: Record<string, string> = {}
      for (const [k, v] of Object.entries(context.drawings)) if (keep.has(k)) drawings[k] = v
      return {
        items: params.items,
        focus: Math.min(context.focus, Math.max(0, params.items.length - 1)),
        edits: context.edits.filter((e) => keep.has(e.selector)),
        drawings,
      }
    }),
    recordEdit: assign(
      ({ context }, p: { selector: string; property: DesignStyleKey; value: string }) => {
        const item = context.items.find((i) => i.selector === p.selector)
        const prior = context.edits.find(
          (e) => e.selector === p.selector && e.property === p.property,
        )
        const from = prior?.from ?? item?.styles[p.property] ?? ''
        const rest = context.edits.filter((e) => e !== prior)
        // Typed back to where it started: no edit left to send.
        const edit: DesignStyleEdit = {
          selector: p.selector,
          property: p.property,
          from,
          to: p.value,
        }
        return { edits: p.value === from ? rest : [...rest, edit], error: null }
      },
    ),
    clearRequest: assign({ instruction: '', edits: [], drawings: {}, error: null }),
    reset: assign({ ...cleared, error: null }),
    recordError: assign((_, params: { error: unknown }) => ({
      error: params.error instanceof Error ? params.error.message : String(params.error),
    })),
  },
  guards: {
    hasItems: (_, params: { count: number }) => params.count > 0,
    hasSelection: ({ context }) => context.items.length > 0,
    hasRequest: ({ context }) => hasRequest(context),
    hasCrop: ({ context }, params: { selector: string }) =>
      context.items.some((i) => i.selector === params.selector && i.crop !== null),
    /** Empty (back to the page's own) or a value CSS takes for the property. */
    validStyle: (_, p: { property: DesignStyleKey; value: string }) =>
      p.value.trim() === '' || (globalThis.CSS?.supports?.(p.property, p.value) ?? true),
  },
}).createMachine({
  id: 'designMode',
  initial: 'off',
  context: ({ input }) => ({ tabId: input.tabId, ...cleared, error: null }),
  states: {
    off: {
      on: { 'design.toggle': { target: 'starting', actions: 'reset' } },
    },
    starting: {
      invoke: {
        src: 'setMode',
        input: ({ context }) => ({ tabId: context.tabId, on: true }),
        onDone: 'on',
        onError: {
          target: 'off',
          actions: { type: 'recordError', params: ({ event }) => ({ error: event.error }) },
        },
      },
      on: {
        // Ended before main answered: stopping turns main's session off again.
        'design.toggle': 'stopping',
        'design.exit': 'stopping',
        'page.left': { target: 'off', actions: 'reset' },
        // A click that beat the answer: kept, and `picking` moves on to `selected`.
        'page.selection': {
          actions: { type: 'takeSelection', params: ({ event }) => ({ items: event.items }) },
        },
      },
    },
    on: {
      initial: 'picking',
      on: {
        'design.toggle': 'stopping',
        'design.exit': 'stopping',
        'page.left': { target: 'off', actions: 'reset' },
        'style.previewed': {
          actions: assign({ previewing: ({ context }) => Math.max(0, context.previewing - 1) }),
        },
        'style.rejected': {
          actions: assign({
            edits: ({ context, event }) =>
              context.edits.filter(
                (e) =>
                  !(
                    e.selector === event.selector &&
                    e.property === event.property &&
                    e.to === event.value
                  ),
              ),
            error: ({ event }) => event.message,
            previewing: ({ context }) => Math.max(0, context.previewing - 1),
          }),
        },
      },
      states: {
        picking: {
          always: { guard: 'hasSelection', target: 'selected' },
          on: {
            'page.selection': {
              guard: { type: 'hasItems', params: ({ event }) => ({ count: event.items.length }) },
              target: 'selected',
              actions: { type: 'takeSelection', params: ({ event }) => ({ items: event.items }) },
            },
          },
        },
        selected: {
          initial: 'editing',
          on: {
            'page.selection': [
              {
                guard: { type: 'hasItems', params: ({ event }) => ({ count: event.items.length }) },
                actions: { type: 'takeSelection', params: ({ event }) => ({ items: event.items }) },
              },
              { target: 'picking', actions: 'reset' },
            ],
            'item.focus': {
              actions: assign({
                focus: ({ context, event }) =>
                  Math.max(0, Math.min(event.index, context.items.length - 1)),
              }),
            },
            'item.remove': {
              actions: {
                type: 'selectInPage',
                params: ({ context, event }) => ({
                  tabId: context.tabId,
                  selectors: context.items
                    .map((i) => i.selector)
                    .filter((s) => s !== event.selector),
                }),
              },
            },
            // The selection went with a chat message (the composer's chips, design-chips.ts).
            'request.consumed': { target: '.sent', actions: 'clearRequest' },
            'instruction.change': {
              target: '.editing',
              actions: assign({ instruction: ({ event }) => event.text, error: null }),
            },
            'style.edit': [
              {
                guard: {
                  type: 'validStyle',
                  params: ({ event }) => ({ property: event.property, value: event.value }),
                },
                target: '.editing',
                actions: [
                  {
                    type: 'recordEdit',
                    params: ({ event }) => ({
                      selector: event.selector,
                      property: event.property,
                      value: event.value,
                    }),
                  },
                  assign({ previewing: ({ context }) => context.previewing + 1 }),
                  {
                    type: 'previewStyle',
                    params: ({ context, event }) => ({
                      tabId: context.tabId,
                      selector: event.selector,
                      property: event.property,
                      value: event.value,
                    }),
                  },
                ],
              },
              {
                // Not CSS for that property: nothing changes in the page, the inspector says why.
                actions: assign({
                  error: ({ event }) =>
                    `"${event.value.slice(0, 60)}" is not a ${event.property} value`,
                }),
              },
            ],
            'draw.open': {
              guard: { type: 'hasCrop', params: ({ event }) => ({ selector: event.selector }) },
              target: 'drawing',
              actions: assign({
                drawingOf: ({ event }) => event.selector,
                drawingFrom: ({ context, event }) =>
                  context.drawings[event.selector] ??
                  context.items.find((i) => i.selector === event.selector)?.crop?.png ??
                  null,
              }),
            },
          },
          states: {
            editing: {
              // A Send pressed while previews were out goes once the page answered them (one it
              // refused is out of the request by then); nothing left to say drops it.
              always: [
                {
                  guard: ({ context }) =>
                    context.sendQueued && context.previewing === 0 && hasRequest(context),
                  target: '#designMode.on.sending',
                  actions: assign({ sendQueued: false }),
                },
                {
                  guard: ({ context }) => context.sendQueued && context.previewing === 0,
                  actions: assign({ sendQueued: false }),
                },
              ],
              on: {
                'request.send': [
                  {
                    guard: ({ context }) => context.previewing === 0 && hasRequest(context),
                    target: '#designMode.on.sending',
                  },
                  {
                    guard: ({ context }) => context.previewing > 0 && hasRequest(context),
                    actions: assign({ sendQueued: true }),
                  },
                ],
              },
            },
            // The request went to the chat; the selection stays while the page hot-reloads.
            sent: {
              on: {
                // Another element picked after the request went: its chips and panel are live again.
                'page.selection': {
                  guard: ({ context, event }) =>
                    event.items.length > 0 &&
                    (event.items.length !== context.items.length ||
                      event.items.some((i, n) => i.selector !== context.items[n]?.selector)),
                  target: 'editing',
                  actions: {
                    type: 'takeSelection',
                    params: ({ event }) => ({ items: event.items }),
                  },
                },
              },
            },
          },
        },
        drawing: {
          on: {
            'page.selection': [
              {
                // The element being drawn on is still selected: keep drawing.
                guard: ({ context, event }) =>
                  event.items.some((i) => i.selector === context.drawingOf),
                actions: { type: 'takeSelection', params: ({ event }) => ({ items: event.items }) },
              },
              {
                guard: { type: 'hasItems', params: ({ event }) => ({ count: event.items.length }) },
                target: 'selected',
                actions: [
                  { type: 'takeSelection', params: ({ event }) => ({ items: event.items }) },
                  assign({ drawingOf: null, drawingFrom: null }),
                ],
              },
              { target: 'picking', actions: 'reset' },
            ],
            'draw.done': {
              target: 'selected',
              actions: assign({
                drawings: ({ context, event }) =>
                  context.drawingOf === null
                    ? context.drawings
                    : { ...context.drawings, [context.drawingOf]: event.png },
                drawingOf: null,
                drawingFrom: null,
              }),
            },
            'draw.cancel': {
              target: 'selected',
              actions: assign({ drawingOf: null, drawingFrom: null }),
            },
          },
        },
        sending: {
          invoke: {
            src: 'sendRequest',
            input: ({ context }) => ({
              tabId: context.tabId,
              items: context.items,
              instruction: context.instruction,
              edits: context.edits,
              drawings: context.drawings,
            }),
            onDone: { target: 'selected.sent', actions: 'clearRequest' },
            onError: {
              target: 'selected',
              actions: { type: 'recordError', params: ({ event }) => ({ error: event.error }) },
            },
          },
          on: {
            // The page can change while the prompt goes (a hot update): keep the selection current.
            'page.selection': {
              guard: { type: 'hasItems', params: ({ event }) => ({ count: event.items.length }) },
              actions: { type: 'takeSelection', params: ({ event }) => ({ items: event.items }) },
            },
          },
        },
      },
    },
    stopping: {
      entry: 'reset',
      invoke: {
        src: 'setMode',
        input: ({ context }) => ({ tabId: context.tabId, on: false }),
        onDone: 'off',
        onError: 'off',
      },
    },
  },
})
