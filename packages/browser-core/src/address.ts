/** Schemes a guest view may load, whoever asks (address bar, links, extensions). */
export const LOADABLE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'about:'])

/** Chromium's ERR_BLOCKED_BY_CLIENT; the host reports a refused scheme under this code. */
export const BLOCKED_URL_CODE = -20

/**
 * Whether the guest view may load `url`. `file:`, `chrome:` and friends are refused at this
 * single choke point so the address bar cannot bypass the page-navigation guard. Extension
 * pages (`chrome-extension:`) open only when the extension host itself asks.
 */
export function loadableUrl(url: string, opts: { fromExtension?: boolean } = {}): boolean {
  // Same scheme grammar as the URL parser (RFC 3986), without needing a URL global here.
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url)
  if (!m) return false
  const protocol = m[1]!.toLowerCase() + ':'
  if (LOADABLE_PROTOCOLS.has(protocol)) return true
  return protocol === 'chrome-extension:' && opts.fromExtension === true
}

/**
 * Port of the Rust address bar rules (apps/evaos/src/panel/browser.rs `normalize`):
 * a bare 2 to 5 digit port opens loopback, a typed scheme is kept, localhost and loopback
 * hosts get http, anything domain-like gets https, and the rest becomes a web search.
 */
export function normalize(input: string): string | null {
  const typed = input.trim()
  if (typed === '') return null
  if (/^[0-9]{2,5}$/.test(typed)) return `http://127.0.0.1:${typed}/`
  if (typed.includes('://')) return typed

  const host = typed.split(/[/?#]/)[0] ?? typed
  const cut = host.lastIndexOf(':')
  let name = host
  if (cut >= 0) {
    const port = host.slice(cut + 1)
    if (/^[0-9]*$/.test(port)) name = host.slice(0, cut)
  }
  if (name === 'localhost' || name === '127.0.0.1' || name === '[::1]') return `http://${typed}`
  if (!/\s/.test(typed) && name.includes('.') && !name.endsWith('.')) return `https://${typed}`
  const words = typed.split(/\s+/).filter(Boolean).map(encodeURIComponent)
  return `https://www.google.com/search?q=${words.join('+')}`
}
