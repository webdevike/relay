import { assign, fromCallback, fromPromise, setup } from 'xstate'
import { MODEL_MAX_BYTES } from '@evaos/chat-core/model-limit'

/**
 * One openui Model block in a chat (docs/state-machines/chat-model-viewer.md). It opens as a poster
 * (name, size, "Click to view in 3D") and fetches nothing heavy: `info` asks main for the file's
 * size without downloading it. Only a click makes it `live`: the `scene` actor downloads the GLB,
 * creates the WebGL context and draws; leaving `live` (another model opened, scrolled far away,
 * unmounted) stops it, which disposes the geometry and gives the context back. At most one model is
 * live in the whole app (`claim`/`release`, model-viewer.ts). Past MODEL_MAX_BYTES it never opens.
 * Effects are provided by model-viewer.ts.
 */

export interface ModelInfo {
  /** File size in bytes; null when the server did not say. */
  size: number | null
  /** The file's own name, when the server sent one. */
  name: string | null
}

export interface ModelViewerContext extends ModelInfo {
  /** Why the last load failed, for the frame. */
  error: string | null
}

export type ModelViewerEvent =
  /** Isaac clicked the poster (or Retry). */
  | { type: 'viewer.open' }
  /** Another model opened, or this one went far off screen. */
  | { type: 'viewer.close' }
  | { type: 'viewer.loaded' }
  | { type: 'viewer.failed'; message: string }
  /** The download turned out bigger than the limit. */
  | { type: 'viewer.tooLarge'; size: number }

export const modelViewerMachine = setup({
  types: {
    context: {} as ModelViewerContext,
    events: {} as ModelViewerEvent,
  },
  actors: {
    info: fromPromise<ModelInfo>(() => Promise.resolve({ size: null, name: null })),
    // Mounts the viewer and returns its teardown; reports loaded, failed or tooLarge.
    scene: fromCallback<ModelViewerEvent>(() => () => {}),
    // Sends viewer.close once the frame is far off screen.
    away: fromCallback<ModelViewerEvent>(() => () => {}),
  },
  actions: {
    // Become the one live model (the previous one closes); provided by the runtime.
    claim: () => {},
    release: () => {},
  },
  guards: {
    tooLarge: ({ context }) => context.size !== null && context.size > MODEL_MAX_BYTES,
  },
}).createMachine({
  id: 'modelViewer',
  context: { size: null, name: null, error: null },
  initial: 'probing',
  states: {
    probing: {
      invoke: {
        src: 'info',
        onDone: { target: 'poster', actions: assign(({ event }) => event.output) },
        onError: 'poster',
      },
      on: { 'viewer.open': 'live' },
    },
    poster: {
      always: { guard: 'tooLarge', target: 'tooLarge' },
      on: { 'viewer.open': 'live' },
    },
    live: {
      tags: ['live'],
      entry: 'claim',
      exit: 'release',
      invoke: [{ src: 'scene' }, { src: 'away' }],
      initial: 'loading',
      on: {
        'viewer.close': 'poster',
        'viewer.failed': {
          target: 'failed',
          actions: assign({ error: ({ event }) => event.message }),
        },
        'viewer.tooLarge': {
          target: 'tooLarge',
          actions: assign({ size: ({ event }) => event.size }),
        },
      },
      states: {
        loading: { on: { 'viewer.loaded': 'ready' } },
        ready: {},
      },
    },
    failed: {
      on: { 'viewer.open': 'live' },
    },
    tooLarge: {},
  },
})
