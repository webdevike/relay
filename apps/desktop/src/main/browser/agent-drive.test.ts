import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun } from '@evaos/contract'
import {
  AgentDrive,
  ASK_WAIT_MS,
  type DriveHost,
  type DriveIdentity,
  type DrivePage,
} from './agent-drive'
import type { ElementInfo } from './agent-guard'

const PENNY: DriveIdentity = {
  id: 'penny',
  name: 'Penny',
  color: '#86efac',
  avatar: null,
  workspace: 'page:agent:penny',
}
const NOVA: DriveIdentity = {
  id: 'nova',
  name: 'Nova',
  color: '#93c5fd',
  avatar: null,
  workspace: 'page:agent:nova',
}

const button = (label: string): ElementInfo => ({
  tag: 'button',
  type: 'submit',
  role: '',
  label,
  href: '',
  submits: false,
  form: null,
  editable: false,
})

/** One tab `t1` on a checkout page: labels by text, clicks recorded. */
function setup() {
  let agent: AgentRun | undefined
  const input: Array<(id: string) => void> = []
  const clicks: string[] = []
  let target = button('Place your order')
  const wc = {
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => 'https://shop.test/checkout',
    getTitle: () => 'Checkout',
    once: () => undefined,
  }
  const page = {
    byText: async (t: string) => {
      target = button(t)
      return 7
    },
    bySelector: async () => 7,
    atPoint: async () => 7,
    center: async () => ({ x: 10, y: 20 }),
    info: async () => target,
    focused: async () => null,
    text: async () => ({ text: 'Items $84.99\nOrder total: $89.99', truncated: false }),
    mouseClick: async () => {
      clicks.push(target.label)
    },
    cursor: async () => undefined,
    viewport: async () => undefined,
    evaluate: async () => 0,
  } as unknown as DrivePage
  const host = {
    agentOf: () => agent,
    setAgent: (_id: string, a: AgentRun | undefined) => {
      agent = a
    },
    allTabs: () => [
      {
        state: { id: 't1', url: wc.getURL(), title: 'Checkout', ...(agent ? { agent } : {}) },
        scope: 'page:agent:penny',
      },
    ],
    isShown: () => false,
    driveView: () => ({ webContents: wc }),
    driveViewport: () => ({ width: 1280, height: 800 }),
    acting: <T>(_id: string, fn: () => Promise<T>) => fn(),
    onUserInput: (cb: (id: string) => void) => input.push(cb),
    pageControl: () => page,
  } as unknown as DriveHost
  let who = PENNY
  const drive = new AgentDrive(host, async () => who)
  return {
    drive,
    clicks,
    status: () => agent?.status,
    agent: () => agent,
    isaac: () => input.forEach((cb) => cb('t1')),
    as: (w: DriveIdentity) => {
      who = w
    },
  }
}

const click = (d: AgentDrive, text: string) =>
  d.click('t1', { text }, undefined, undefined, 'agent:penny')

/** Waits until the drive asks for Isaac's Allow. */
async function asked(s: ReturnType<typeof setup>): Promise<void> {
  await vi.waitFor(() => expect(s.status()).toBe('ask'))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AgentDrive', () => {
  it('runs safe clicks at once and holds a purchase until Isaac allows it', async () => {
    const s = setup()
    await click(s.drive, 'Add to Cart')
    expect(s.clicks).toEqual(['Add to Cart'])
    expect(s.agent()).toMatchObject({
      name: 'Penny',
      status: 'working',
      caption: 'Clicking "Add to Cart"',
    })

    const placing = click(s.drive, 'Place your order')
    await asked(s)
    expect(s.agent()?.ask?.label).toBe('place your order, $89.99')
    expect(s.clicks).toEqual(['Add to Cart'])
    s.drive.op('t1', 'allow')
    await expect(placing).resolves.toMatchObject({ clicked: { label: 'Place your order' } })
    expect(s.clicks).toEqual(['Add to Cart', 'Place your order'])
    expect(s.status()).toBe('working')
  })

  it('stops on Not now and tells the agent not to retry', async () => {
    const s = setup()
    const placing = click(s.drive, 'Place your order')
    await asked(s)
    s.drive.op('t1', 'deny')
    await expect(placing).rejects.toMatchObject({ code: 'declined-by-isaac' })
    expect(s.clicks).toEqual([])
    expect(s.agent()).toMatchObject({
      status: 'stopped',
      caption: 'Stopped before: place your order, $89.99',
    })
    s.drive.op('t1', 'dismiss')
    expect(s.agent()).toMatchObject({ status: 'idle', caption: '' })
  })

  it("pauses on Isaac's own input until he hands back", async () => {
    const s = setup()
    await click(s.drive, 'Add to Cart')
    s.isaac()
    expect(s.status()).toBe('paused')
    await expect(click(s.drive, 'Add to Cart')).rejects.toMatchObject({ code: 'paused-by-isaac' })
    const back = s.drive.wait('t1', 'handback', undefined, 5000)
    s.drive.op('t1', 'handBack')
    await expect(back).resolves.toEqual({ met: true, status: 'working' })
    await click(s.drive, 'Add to Cart')
    expect(s.clicks).toEqual(['Add to Cart', 'Add to Cart'])
  })

  it('turns a waiting Allow into a pause when Isaac takes over instead', async () => {
    const s = setup()
    const placing = click(s.drive, 'Place your order')
    await asked(s)
    s.isaac()
    await expect(placing).rejects.toMatchObject({ code: 'paused-by-isaac' })
    expect(s.agent()).toMatchObject({ status: 'paused', ask: null })
    expect(s.clicks).toEqual([])
  })

  it('answers awaiting-approval after the wait, and still runs the action when Isaac allows later', async () => {
    vi.useFakeTimers()
    const s = setup()
    const placing = click(s.drive, 'Place your order')
    const failed = expect(placing).rejects.toMatchObject({ code: 'awaiting-approval' })
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS + 10)
    await failed
    expect(s.status()).toBe('ask')
    await expect(click(s.drive, 'Add to Cart')).rejects.toMatchObject({ code: 'awaiting-approval' })
    const approval = s.drive.wait('t1', 'approval', undefined, 30_000)
    s.drive.op('t1', 'allow')
    await vi.advanceTimersByTimeAsync(500)
    await expect(approval).resolves.toMatchObject({ met: true, allowed: true })
    expect(s.clicks).toEqual(['Place your order'])
  })

  it('never drives a page mid-run for another agent', async () => {
    const s = setup()
    await click(s.drive, 'Add to Cart')
    s.as(NOVA)
    await expect(click(s.drive, 'Add to Cart')).rejects.toMatchObject({ code: 'busy' })
    s.as(PENNY)
    await s.drive.done('t1', 'Cart ready', 'done', 'agent:penny')
    expect(s.agent()).toMatchObject({ status: 'done', caption: 'Cart ready' })
    // A finished page is anyone's again.
    s.as(NOVA)
    await click(s.drive, 'Add to Cart')
    expect(s.agent()).toMatchObject({ name: 'Nova', status: 'working' })
  })
})
