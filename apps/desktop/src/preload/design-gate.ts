import {
  DESIGN_GATE_CHANNEL,
  DESIGN_GATE_QUERY,
  DESIGN_INPUT_EVENT,
  type DesignInput,
} from './guest-channel'

/** The part of ipcRenderer the gate uses. */
export interface GateIpc {
  on(channel: string, listener: (event: unknown, on: unknown) => void): unknown
  invoke(channel: string): Promise<unknown>
}

const POINTER = [
  'mousemove',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'mouseover',
  'mouseout',
  'mouseenter',
  'mouseleave',
  'pointermove',
  'pointerdown',
  'pointerup',
  'pointerover',
  'pointerout',
  'pointerenter',
  'pointerleave',
  'pointercancel',
]

// No focus, text selection, context menu or activation (links, checkboxes, buttons); pointer
// events keep their default, which fires the mouse events forwarded below.
const NO_DEFAULT: Record<string, true> = {
  mousedown: true,
  contextmenu: true,
  click: true,
  dblclick: true,
  auxclick: true,
}

const FORWARD: Record<string, true> = { mousemove: true, mousedown: true, mouseup: true }

/**
 * Design Mode's pointer gate (guest-channel.ts), in a page's top frame. Installed before any page
 * script, its window capture listeners run ahead of the page's, so while main has it on no
 * listener of the page's sees the pointer; the design picker gets each move, press and release
 * from DESIGN_INPUT_EVENT on the document. A new document asks main as it starts, so a reload under
 * Design Mode is gated once main answers, well before dom-ready; a gate message that arrives first
 * wins over that answer. The wheel is not gated: the page still scrolls. Frames get no preload:
 * the picker's shield covers them.
 */
export function installDesignGate(win: Window & typeof globalThis, ipc: GateIpc): void {
  let gated = false
  let told = false
  ipc.on(DESIGN_GATE_CHANNEL, (_event, on) => {
    told = true
    gated = on === true
  })
  ipc.invoke(DESIGN_GATE_QUERY).then(
    (on) => {
      if (!told) gated = on === true
    },
    () => undefined,
  )
  for (const type of POINTER) {
    win.addEventListener(
      type,
      (e) => {
        if (!gated) return
        e.stopImmediatePropagation()
        if (NO_DEFAULT[type]) e.preventDefault()
        if (!(e instanceof win.MouseEvent) || !FORWARD[type]) return
        const input: DesignInput = {
          type: type as DesignInput['type'],
          x: e.clientX,
          y: e.clientY,
          button: e.button,
          shift: e.shiftKey,
        }
        win.document.dispatchEvent(
          new win.CustomEvent(DESIGN_INPUT_EVENT, { detail: JSON.stringify(input) }),
        )
      },
      true,
    )
  }
}
