/** Pure pin-to-bottom state machine for the chat log (CHAT-05, D-18). */
export const PIN_THRESHOLD_PX = 24

export interface PinState {
  pinned: boolean
  newReply: boolean
}

export type PinEvent = { type: 'scroll'; gapPx: number } | { type: 'output' } | { type: 'jump' }

export function pinReducer(state: PinState, ev: PinEvent): PinState {
  switch (ev.type) {
    case 'scroll':
      return ev.gapPx <= PIN_THRESHOLD_PX
        ? state.pinned && !state.newReply
          ? state
          : { pinned: true, newReply: false }
        : state.pinned
          ? { ...state, pinned: false }
          : state
    case 'output':
      return state.pinned || state.newReply ? state : { ...state, newReply: true }
    case 'jump':
      return { pinned: true, newReply: false }
  }
}
