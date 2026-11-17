// The window mirror (Relay Host `workspace.*`, @relay/protocol workspace.ts): every Relay Desktop on
// one host shows the same app tabs, tab in front, panes and web pages, live. This Mac's side runs the
// shell-core workspaceMirrorMachine: what the window saves (layout.json `tabs` and `workspaces`) and
// the browser's pages go up as entries; another Mac's entries come down into layout.json, the
// window (`workspace.remote`) and the browser. Window bounds, the sidebar and UI choices stay on
// each Mac. Only the live app (and e2e runs) mirror: a dev build on the same host never does.
import { randomBytes } from 'node:crypto'
import * as os from 'node:os'
import {
  fromEntries,
  patchEntries,
  readWorkspaces,
  saveWorkspaces,
  toEntries,
  workspaceMirrorMachine,
  type Entries,
  type MirrorPage,
  type Workspaces,
} from '@evaos/shell-core'
import { WORKSPACE_FEATURE } from '@relay/protocol'
import { createActor } from 'xstate'
import type { MainContext } from '../context'
import { emit } from '../ipc/handle'
import { loadLayout, type LayoutIpc } from '../layout-ipc'
import type { RelayFeatures, RelayFrames, RelaySource } from '../relay/client'
import type { BrowserHost } from '../browser/browser-host'
import type { EventPayload } from '@evaos/contract'

/** A burst of tab changes (a page loading: start, title, favicon, stop) goes up as one report. */
const REPORT_MS = 120

const PAGE = 'page:'

export interface WorkspaceMirrorDeps {
  layout: LayoutIpc
  frames: RelayFrames & RelayFeatures & Pick<RelaySource, 'onChange'>
  browser: Pick<BrowserHost, 'mirrorPages' | 'applyMirrorPages' | 'onPagesChanged'>
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isPage = (v: unknown): v is MirrorPage =>
  isObject(v) &&
  typeof v['url'] === 'string' &&
  typeof v['title'] === 'string' &&
  typeof v['scope'] === 'string'

const keysOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : []

/** Starts the mirror; answers its stop. */
export function startWorkspaceMirror(ctx: MainContext, deps: WorkspaceMirrorDeps): () => void {
  const { layout, frames, browser } = deps
  const saved = loadLayout(ctx.config)
  let tabs: unknown = saved.tabs
  let workspaces: Workspaces | null = readWorkspaces(saved.workspaces)
  const current = (): Entries => toEntries({ tabs, workspaces, pages: browser.mirrorPages() })
  /** What this Mac shows, as the machine last heard it (patched by remote changes). */
  let shown = current()
  let applying = false
  const origin = `relay-desktop-${os.hostname()}-${randomBytes(4).toString('hex')}`

  const apply = (set: Entries, del: string[]): void => {
    shown = patchEntries(shown, set, del)
    const pageSet: Record<string, MirrorPage> = {}
    const pageDel: string[] = []
    let window = false
    for (const [k, v] of Object.entries(set)) {
      if (!k.startsWith(PAGE)) window = true
      else if (isPage(v)) pageSet[k.slice(PAGE.length)] = v
    }
    for (const k of del) {
      if (!k.startsWith(PAGE)) window = true
      else pageDel.push(k.slice(PAGE.length))
    }
    applying = true
    try {
      if (Object.keys(pageSet).length > 0 || pageDel.length > 0) {
        browser.applyMirrorPages(pageSet, pageDel)
      }
    } finally {
      applying = false
    }
    if (!window) return
    const state = fromEntries(shown)
    tabs = state.tabs
    workspaces = state.workspaces
    const record = workspaces ? saveWorkspaces(workspaces) : null
    void layout.write({
      ...(tabs !== null ? { tabs } : {}),
      ...(record !== null ? { workspaces: record } : {}),
    })
    emit(ctx, 'workspace.remote', {
      tabs: tabs as EventPayload<'workspace.remote'>['tabs'],
      workspaces: record,
    })
  }

  const actor = createActor(
    workspaceMirrorMachine.provide({
      actions: {
        sendGet: () => {
          frames.sendFrame({ t: 'workspace.get' })
        },
        sendPut: (_, p) => {
          frames.sendFrame({
            t: 'workspace.put',
            rid: p.rid,
            origin,
            set: p.set,
            del: p.del,
            ...(p.seed ? { seed: true } : {}),
          })
        },
        applyEntries: (_, p) => apply(p.set, p.del),
      },
    }),
    { input: { origin, entries: shown } },
  ).start()

  let timer: NodeJS.Timeout | undefined
  const report = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      shown = current()
      actor.send({ type: 'local.changed', entries: shown })
    }, REPORT_MS)
  }

  const offSaved = layout.onSaved((patch) => {
    if (patch.tabs !== undefined) tabs = patch.tabs
    if (patch.workspaces !== undefined) workspaces = readWorkspaces(patch.workspaces)
    report()
  })
  const offPages = browser.onPagesChanged(() => {
    if (!applying) report()
  })

  let up = false
  const check = (): void => {
    const now = frames.hostHas(WORKSPACE_FEATURE)
    if (now === up) return
    up = now
    actor.send({ type: now ? 'host.up' : 'host.down' })
  }
  const offChange = frames.onChange(check)
  const offFrame = frames.onFrame((f) => {
    switch (f.t) {
      case 'welcome':
        // A new connection: whatever the last one was doing is gone.
        if (up) {
          up = false
          actor.send({ type: 'host.down' })
        }
        check()
        return
      case 'workspace.state':
        if (typeof f['rev'] === 'number' && isObject(f['entries'])) {
          actor.send({ type: 'host.state', rev: f['rev'], entries: f['entries'] })
        }
        return
      case 'workspace.changed':
        if (typeof f['rev'] === 'number' && isObject(f['set']) && typeof f['origin'] === 'string') {
          actor.send({
            type: 'host.changed',
            rev: f['rev'],
            origin: f['origin'],
            set: f['set'],
            del: keysOf(f['del']),
          })
        }
        return
      case 'workspace.ack':
        if (typeof f['rid'] === 'string' && typeof f['rev'] === 'number') {
          actor.send({
            type: 'host.ack',
            rid: f['rid'],
            rev: f['rev'],
            applied: f['applied'] === true,
          })
        }
        return
    }
  })
  check()

  return () => {
    clearTimeout(timer)
    offSaved()
    offPages()
    offChange()
    offFrame()
    actor.stop()
  }
}
