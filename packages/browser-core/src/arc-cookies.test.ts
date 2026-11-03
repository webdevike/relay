import { describe, expect, it } from 'vitest'
import { parseArcExport, toElectronCookie } from './arc-cookies'

describe('arc cookies', () => {
  it('maps the Rust host-only __Host- case with no domain', () => {
    const c = toElectronCookie({
      name: '__Host-user_session_same_site',
      value: 's',
      expires: 1893456000,
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      url: 'https://github.com/',
    })
    expect(c).toEqual({
      url: 'https://github.com/',
      name: '__Host-user_session_same_site',
      value: 's',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'strict',
      expirationDate: 1893456000,
    })
    expect(c).not.toHaveProperty('domain')
  })

  it('maps a dotted domain cookie with expires -1 to a session cookie', () => {
    const c = toElectronCookie({
      name: '_ga',
      value: 'g',
      expires: -1,
      domain: '.github.com',
      path: '/',
    })
    expect(c?.url).toBe('http://github.com/')
    expect(c?.domain).toBe('.github.com')
    expect(c).not.toHaveProperty('expirationDate')
    expect(c?.sameSite).toBe('unspecified')
  })

  it('maps sameSite values', () => {
    const base = { name: 'a', value: 'b', domain: 'x.com' }
    expect(toElectronCookie({ ...base, sameSite: 'None' })?.sameSite).toBe('no_restriction')
    expect(toElectronCookie({ ...base, sameSite: 'Lax' })?.sameSite).toBe('lax')
    expect(toElectronCookie(base)?.sameSite).toBe('unspecified')
  })

  it('keeps a non-root path on the domain form', () => {
    const c = toElectronCookie({
      name: 'sid',
      value: 'x',
      domain: 'accounts.google.com',
      path: '/signin',
      secure: true,
    })
    expect(c?.url).toBe('https://accounts.google.com/signin')
    expect(c?.path).toBe('/signin')
  })

  it('drops invalid entries, keeps neighbours, and rejects non-array JSON', () => {
    const out = parseArcExport(
      JSON.stringify([
        { name: 'broken' },
        { value: 'no name', domain: 'x.com' },
        { name: 'ok', value: '1', domain: 'x.com' },
      ]),
    )
    expect(out.map((c) => c.name)).toEqual(['ok'])
    expect(() => parseArcExport('{"a":1}')).toThrow('The Arc export was not JSON')
    expect(() => parseArcExport('Error: no keychain')).toThrow('The Arc export was not JSON')
  })
})
