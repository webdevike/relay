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
