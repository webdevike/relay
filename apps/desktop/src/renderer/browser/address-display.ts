/**
 * How the address field reads while nobody edits it, like a browser's omnibox: the host first,
 * the rest of the address dimmed, no `https://`. `secure` picks the lock glyph. Anything that is
 * not a web address (a chrome-extension: page, an unparsable string) shows as typed, whole.
 */
export interface AddressDisplay {
  host: string
  rest: string
  secure: boolean
}

export function addressDisplay(url: string): AddressDisplay | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}${u.hash}`
  const host = u.protocol === 'http:' ? `http://${u.host}` : u.host
  return { host, rest, secure: u.protocol === 'https:' }
}
