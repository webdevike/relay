import { buildAppLink, parseAppLink, type AppLink } from '@evaos/chat-core/widget'
import { placeOf, type Place } from '@evaos/shell-core'

/**
 * What a relay:// address names, one shape per tab kind. Formats (values URL-encoded):
 * - chat: `relay://open/chat?chat=<session file>[&message=<id>]`
 * - assistant thread: `relay://assistant/<id>`
 * - web page: `relay://open/web?url=<http(s) url>[&ws=<workspace>]`
 * - file: `relay://open/files?path=<path>[&line=<n>][&ws=<workspace>]`
 * - canvas board: `relay://open/canvas?canvas=<slug>[&node=<id>]`
 * - Studio job: `relay://open/studio?job=<id>`
 * - review item: `relay://open/reviews?item=<review id or item url>`
 * - any other page: `relay://open/<page>[/<sub>]` (`settings/<section>`, `workspace/<slug>`, ...)
 */
export type TabAddress =
  | { kind: 'chat'; file: string; message?: string }
  | { kind: 'assistant'; id: string }
  | { kind: 'web'; url: string; ws?: string }
  | { kind: 'file'; path: string; line?: number; ws?: string }
  | { kind: 'canvas'; board: string; node?: string }
  | { kind: 'studio'; job: string }
  | { kind: 'review'; item: string }
  | { kind: 'page'; link: Extract<AppLink, { kind: 'open' }> }

const ws = (v: string | undefined): { ws?: string } => (v === undefined ? {} : { ws: v })

/** The canonical relay:// URL of `a`; parseAddress reads it back. */
export function formatAddress(a: TabAddress): string {
  switch (a.kind) {
    case 'assistant':
      return buildAppLink({ kind: 'assistant', id: a.id })
    case 'chat':
      return open('chat', { chat: a.file, message: a.message })
    case 'web':
      return open('web', { url: a.url, ws: a.ws })
    case 'file':
      return open('files', {
        path: a.path,
        line: a.line === undefined ? undefined : String(a.line),
        ws: a.ws,
      })
    case 'canvas':
      return open('canvas', { canvas: a.board, node: a.node })
    case 'studio':
      return open('studio', { job: a.job })
    case 'review':
      return open('reviews', { item: a.item })
    case 'page':
      return buildAppLink(a.link)
  }
}

function open(page: string, params: Record<string, string | undefined>): string {
  const set = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined))
  return buildAppLink({
    kind: 'open',
    page,
    ...(Object.keys(set).length > 0 ? { params: set } : {}),
  })
}

const isWeb = (u: string): boolean => /^https?:\/\//i.test(u)

/** What a relay:// URL names; null for anything that is not one. Old forms read as `page`. */
export function parseAddress(url: string): TabAddress | null {
  const link = parseAppLink(url)
  if (link === null) return null
  if (link.kind === 'assistant') return { kind: 'assistant', id: link.id }
  const p = link.params ?? {}
  if (link.sub === undefined) {
    if (link.page === 'chat' && p.chat !== undefined) {
      return { kind: 'chat', file: p.chat, ...(p.message === undefined ? {} : { message: p.message }) }
    }
    if (link.page === 'web') {
      return p.url !== undefined && isWeb(p.url) ? { kind: 'web', url: p.url, ...ws(p.ws) } : null
    }
    if (link.page === 'files') {
      if (p.path === undefined) return null
      const line = p.line === undefined ? undefined : Number(p.line)
      return {
        kind: 'file',
        path: p.path,
        ...(line !== undefined && Number.isInteger(line) && line > 0 ? { line } : {}),
        ...ws(p.ws),
      }
    }
    if (link.page === 'canvas' && p.canvas !== undefined) {
      return { kind: 'canvas', board: p.canvas, ...(p.node === undefined ? {} : { node: p.node }) }
    }
    if (link.page === 'studio' && p.job !== undefined) return { kind: 'studio', job: p.job }
    if (link.page === 'reviews' && p.item !== undefined) return { kind: 'review', item: p.item }
  }
  return { kind: 'page', link }
}

/** The address of an in-app place (a chat, a thread, a page). */
export function addressOfPlace(place: Place): TabAddress | null {
  if (place.page === 'chat') {
    return place.chat !== null && place.chat !== '' && place.chat !== 'draft'
      ? { kind: 'chat', file: place.chat }
      : null
  }
  if (place.page.startsWith('agent:')) return { kind: 'assistant', id: place.page.slice(6) }
  if (place.page.startsWith('review:')) return { kind: 'review', item: place.page.slice(7) }
  if (place.page === 'canvas' && place.canvas !== null) {
    return { kind: 'canvas', board: place.canvas }
  }
  const colon = place.page.indexOf(':')
  if (colon > 0) {
    const link = parseAppLink(`relay://open/${place.page.slice(0, colon)}/${place.page.slice(colon + 1)}`)
    return link?.kind === 'open' ? { kind: 'page', link } : null
  }
  const sub = place.page === 'settings' ? `/${place.settingsSection.toLowerCase()}` : ''
  const link = parseAppLink(`relay://open/${place.page}${sub}`)
  return link?.kind === 'open' ? { kind: 'page', link } : null
}

/** The place an address shows in, for the kinds that are places (null for web and files). */
export function placeOfAddress(a: TabAddress): Place | null {
  switch (a.kind) {
    case 'chat':
      return placeOf('chat', { chat: a.file })
    case 'assistant':
      return placeOf(`agent:${a.id}`)
    case 'canvas':
      return placeOf('canvas', { canvas: a.board })
    case 'studio':
      return placeOf('studio')
    default:
      return null
  }
}
