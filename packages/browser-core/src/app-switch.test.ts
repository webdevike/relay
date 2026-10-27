import { describe, expect, it } from 'vitest'
import { isAppSwitchUrl } from './app-switch'

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
