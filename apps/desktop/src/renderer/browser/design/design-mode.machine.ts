import { assign, fromPromise, setup } from 'xstate'
import type { DesignItem, DesignStyleKey } from '@evaos/contract'

/**
 * Design Mode in one page tab (docs/state-machines/design-mode.md): off, turning on, picking
 * elements, one or more selected (the inspector), drawing on a crop, sending the request to the
 * workspace's chat, sent (the selection stays while the page hot-reloads), turning off. Main does
 * the page side (main/browser/design-mode.ts); its `design.selection` and `design.exit` events
 * arrive here as `page.selection`, `design.exit` (Escape) and `page.left` (another site, closed).
 */

/** A value Isaac changed in the inspector: previewed in the page, sent with the request. */
export interface StyleEdit {
  selector: string
  property: DesignStyleKey
  /** The computed value before his first edit of it. */
  from: string
  to: string
}

/** What one Send carries; design-request.ts turns it into the chat prompt. */
export interface DesignDraft {
  items: DesignItem[]
  instruction: string
  edits: StyleEdit[]
  /** Crops Isaac drew on, by selector: PNG base64 replacing that item's plain crop. */
  drawings: Record<string, string>
}

export interface DesignContext extends DesignDraft {
  tabId: string
  /** The item whose styles the inspector shows. */
  focus: number
  /** The selector whose crop is open for drawing, while `drawing`. */
  drawingOf: string | null
  error: string | null
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
  | { type: 'draw.open'; selector: string }
  | { type: 'draw.done'; png: string }
  | { type: 'draw.cancel' }
  | { type: 'request.send' }

const cleared = { items: [], instruction: '', edits: [], drawings: {}, focus: 0, drawingOf: null }

/** True when the request says something: words, a style edit or a drawing. */
export function hasRequest(c: DesignDraft): boolean {
  return (
    c.items.some((i) => !i.missing) &&
    (c.instruction.trim() !== '' || c.edits.length > 0 || Object.keys(c.drawings).length > 0)
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
        const edit: StyleEdit = { selector: p.selector, property: p.property, from, to: p.value }
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
    hasRequest: ({ context }) => hasRequest(context),
    hasCrop: ({ context }, params: { selector: string }) =>
      context.items.some((i) => i.selector === params.selector && i.crop !== null),
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
    },
    on: {
      initial: 'picking',
      on: {
        'design.toggle': 'stopping',
        'design.exit': 'stopping',
        'page.left': { target: 'off', actions: 'reset' },
      },
      states: {
        picking: {
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
            'instruction.change': {
              target: '.editing',
              actions: assign({ instruction: ({ event }) => event.text, error: null }),
            },
            'style.edit': {
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
            'draw.open': {
              guard: { type: 'hasCrop', params: ({ event }) => ({ selector: event.selector }) },
              target: 'drawing',
              actions: assign({ drawingOf: ({ event }) => event.selector }),
            },
          },
          states: {
            editing: {
              on: { 'request.send': { guard: 'hasRequest', target: '#designMode.on.sending' } },
            },
            // The request went to the chat; the selection stays while the page hot-reloads.
            sent: {},
          },
        },
        drawing: {
          on: {
            'page.selection': [
              {
                guard: { type: 'hasItems', params: ({ event }) => ({ count: event.items.length }) },
                actions: { type: 'takeSelection', params: ({ event }) => ({ items: event.items }) },
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
              }),
            },
            'draw.cancel': { target: 'selected', actions: assign({ drawingOf: null }) },
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
