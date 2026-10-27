import { describe, expect, it } from 'vitest'
import { isAppSwitchUrl, switchAppFromSetCookie, withSwitchAppCookie } from './app-switch'

describe('isAppSwitchUrl', () => {
  it('matches pages on the switch origin', () => {
    expect(isAppSwitchUrl('https://localhost:3001/')).toBe(true)
    expect(isAppSwitchUrl('https://localhost:3001/administration/access?x=1#y')).toBe(true)
  })
  it('ignores other ports, hosts, schemes and non-URLs', () => {
    expect(isAppSwitchUrl('https://localhost:3051/')).toBe(false)
    expect(isAppSwitchUrl('https://localhost:30010/')).toBe(false)
    expect(isAppSwitchUrl('http://localhost:3001/')).toBe(false)
    expect(isAppSwitchUrl('https://127.0.0.1:3001/')).toBe(false)
    expect(isAppSwitchUrl('https://localhost.evil.example:3001/')).toBe(false)
    expect(isAppSwitchUrl('about:blank')).toBe(false)
    expect(isAppSwitchUrl('')).toBe(false)
    expect(isAppSwitchUrl(undefined)).toBe(false)
  })
})

describe('withSwitchAppCookie', () => {
  it("replaces the jar's ecard_app and keeps every other cookie", () => {
    expect(withSwitchAppCookie('a=1; ecard_app=assets; b=2', 'rbac')).toBe(
      'a=1; b=2; ecard_app=rbac',
    )
    expect(withSwitchAppCookie('ecard_app=assets;ecard_app=x', 'rbac')).toBe('ecard_app=rbac')
  })
  it('adds the cookie when the request carries none', () => {
    expect(withSwitchAppCookie(undefined, 'rbac')).toBe('ecard_app=rbac')
    expect(withSwitchAppCookie('', 'rbac')).toBe('ecard_app=rbac')
  })
  it('leaves cookies that only start with the same letters', () => {
    expect(withSwitchAppCookie('ecard_app_x=1; my_ecard_app=2', 'rbac')).toBe(
      'ecard_app_x=1; my_ecard_app=2; ecard_app=rbac',
    )
  })
})

describe('switchAppFromSetCookie', () => {
  it("takes the switch's ecard_app cookie out and passes the rest through", () => {
    expect(
      switchAppFromSetCookie([
        'sid=9; Path=/',
        'ecard_app=rbac; Path=/; Max-Age=31536000; SameSite=Lax; Secure',
      ]),
    ).toEqual({ app: 'rbac', rest: ['sid=9; Path=/'] })
  })
  it('finds nothing in unrelated or malformed cookies', () => {
    expect(switchAppFromSetCookie(['ecard_app_x=1', 'ecard_app=../x; Path=/'])).toEqual({
      app: null,
      rest: ['ecard_app_x=1', 'ecard_app=../x; Path=/'],
    })
    expect(switchAppFromSetCookie([])).toEqual({ app: null, rest: [] })
  })
})
