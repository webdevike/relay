import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runAgent, type RunIO } from './agent'
import type { Brain, InputItem, Turn } from './brain'
import { Desktop, type Screen } from './desktop'
import type { Driver } from './driver'
import type { Located, Locator } from './locate'
import type { Presenter, Shown } from './presenter'

/** A PNG header of the picture size; the last byte stands for what the window shows. */
const png = (look: number): Buffer => {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(1200, 16)
  b.writeUInt32BE(800, 20)
  b[32] = look
  return b
}

/**
 * Bambu Studio: a window with no accessible controls whose picture changes after each click. Like
 * the real one, cua-driver cannot resolve it, so a background pixel click is refused.
 */
function bambu() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let look = 1
  const driver: Driver = {
    backend: 'direct',
    close() {},
    async call(name, args) {
      calls.push({ name, args })
      if (name === 'list_windows')
        return {
          result: {
            structuredContent: {
              windows: [
                {
                  app_name: 'Bambu Studio',
                  title: 'plate',
                  pid: 4,
                  window_id: 40,
                  is_on_screen: true,
                  z_index: 1,
                  bounds: { x: 1000, y: 100, width: 1200, height: 800 },
                },
              ],
            },
          },
        }
      if (name === 'launch_app') return { result: { structuredContent: { pid: 4 } } }
      // cua-driver's own capture (needed before a pixel click) is at half the window's size here:
      // it reads click pixels in that frame.
      if (name === 'get_window_state')
        return {
          result: {
            content: [],
            structuredContent: {
              app_name: 'Bambu Studio',
              window_title: 'plate',
              elements: [],
              screenshot_width: 600,
            },
          },
        }
      if (name === 'click' && args.delivery_mode !== 'foreground')
        return {
          result: {
            isError: true,
            content: [{ type: 'text', text: 'refused: off_space_or_ax_unresolved' }],
            structuredContent: { status: 'refused' },
          },
        }
      if (name === 'click') look++
      return { result: { structuredContent: {} } }
    },
  }
  // WindowServer: a picture of the window at 1 pixel per point, as on the Mini's display.
  const screen: Screen = {
    app: async () => ({
      front: true,
      windows: [
        {
          windowId: 40,
          pid: 4,
          layer: 0,
          title: 'plate',
          bounds: { x: 1000, y: 100, w: 1200, h: 800 },
        },
      ],
    }),
    picture: async () => png(look),
  }
  return { driver, calls, screen }
}

/** Sees "Print plate" at the top right whatever it is asked for, or "Slice plate" for slice. */
const locator: Locator = {
  async locate(_image, _size, target): Promise<Located | null> {
    if (/slice/i.test(target)) return { x: 400, y: 10, w: 60, h: 20, label: 'Slice plate' }
    return { x: 500, y: 10, w: 60, h: 20, label: 'Print plate' }
  },
}

/** Opens Bambu Studio, then clicks `target`, then finishes with what the act answered. */
function brain(target: string): Brain {
  let n = 0
  return {
    async turn(items: InputItem[]): Promise<Turn> {
      n++
      if (n === 1)
        return {
          text: '',
          calls: [{ callId: 'c1', name: 'open_app', args: { app: 'Bambu Studio' } }],
        }
      if (n === 2)
        return {
          text: '',
          calls: [
            {
              callId: 'c2',
              name: 'act',
              args: { window_id: 40, reason: 'Slicing', steps: [{ type: 'click', target }] },
            },
          ],
        }
      const out = items.find(
        (i): i is Extract<InputItem, { type: 'function_call_output' }> => 'type' in i,
      )
      return {
        text: '',
        calls: [{ callId: 'c3', name: 'finish', args: { summary: out?.output ?? '' } }],
      }
    },
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function run(target: string, answer: string, mode: 'live' | 'headless' = 'live') {
  const { driver, calls, screen } = bambu()
  const asked: string[] = []
  const clicks: Array<{ x: number; y: number }> = []
  const io: RunIO = {
    progress() {},
    plan() {},
    image() {},
    async ask(q) {
      asked.push(q)
      return answer
    },
    signal: new AbortController().signal,
    stop() {},
  }
  const shown = (): Shown => ({ landed: Promise.resolve(), spoken: Promise.resolve() })
  const presenter: Presenter = {
    assistant() {},
    point: () => shown(),
    click: (x, y) => (clicks.push({ x, y }), shown()),
    caption: () => shown(),
    hide() {},
    onEsc() {},
    close() {},
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-vision-'))
  dirs.push(dir)
  const done = runAgent({
    task: 'slice the plate',
    mode,
    assistant: { id: 'nova', title: 'Nova' },
    desktop: new Desktop(driver, async () => {}, undefined, undefined, screen),
    locator,
    brain: brain(target),
    presenter: mode === 'live' ? presenter : null,
    io,
    shots: { dir, want: 'none' },
    now: () => 0,
  })
  return { done, calls, asked, clicks }
}

describe('runAgent vision fallback', () => {
  it('clicks a custom-drawn control where the picture shows it, with the cursor there first', async () => {
    const r = run('Slice plate', 'Approve')
    const result = await r.done
    const clicks = r.calls.filter((c) => c.name === 'click').map((c) => c.args)
    // The box's centre as a point in the window, in cua-driver's capture frame (half size):
    // background first, and the refusal (nothing delivered) becomes one real click in front.
    const at = { pid: 4, window_id: 40, x: 215, y: 10 }
    expect(clicks).toEqual([at, { ...at, delivery_mode: 'foreground' }])
    // The cursor glides to the same spot in screen points.
    expect(r.clicks).toEqual([{ x: 1430, y: 120 }])
    expect(r.asked).toEqual([])
    expect(result.summary).toMatch(
      /found “Slice plate” in the picture, clicked it in front.*the window changed/,
    )
  })

  it('asks before a risky target and clicks nothing when Isaac cancels', async () => {
    const r = run('Print plate', 'Cancel')
    const result = await r.done
    expect(r.asked).toHaveLength(1)
    expect(r.calls.some((c) => c.name === 'click')).toBe(false)
    expect(result.summary).toMatch(/declined/i)
  })

  it('asks when the picture shows a risky control under a harmless-sounding target', async () => {
    const r = run('the green button top right', 'Cancel')
    const result = await r.done
    expect(r.asked).toEqual([expect.stringMatching(/“Print plate”/)])
    expect(r.calls.some((c) => c.name === 'click')).toBe(false)
    expect(result.summary).toMatch(/Isaac declined/)
  })

  it('headless never clicks in front: the refusal ends the step and says to use live', async () => {
    const r = run('Slice plate', 'Approve', 'headless')
    const result = await r.done
    const clicks = r.calls.filter((c) => c.name === 'click')
    expect(clicks).toHaveLength(1)
    expect(clicks[0]?.args).not.toHaveProperty('delivery_mode')
    expect(r.calls.some((c) => c.name === 'bring_to_front')).toBe(false)
    expect(result.summary).toMatch(/FAILED.*@computer live/)
  })
})
