import { describe, expect, it } from 'vitest'
import { allowGuestPermission, GESTURE_WINDOW_MS, isClipboardReadTrusted } from './guest-permissions'

const FRESH = 100
const TRUSTED = [
  'https://localhost:3001/reports',
  'http://localhost:5173/',
  'http://127.0.0.1:8080/x',
  'https://dev.platform.ecardsystems.com/home',
  'https://stage.platform.ecardsystems.com/',
  'http://ike-mac.tail1234.ts.net:4000/',
  'https://ike-mac.tail1234.ts.net/',
]
const UNTRUSTED = [
  'https://example.com/',
  'https://evil.localhost.example.com/',
  'https://localhost.evil.com/',
  'https://platform.ecardsystems.com/',
  'http://dev.platform.ecardsystems.com/',
  'https://ts.net.evil.com/',
  'file:///Users/ike/secret.html',
  'data:text/html,<p>x</p>',
  'not a url',
  undefined,
]

describe('allowGuestPermission', () => {
  it('allows sanitized clipboard writes on any page, even without a gesture', () => {
    for (const url of [...TRUSTED, ...UNTRUSTED]) {
      expect(allowGuestPermission('clipboard-sanitized-write', url, Infinity)).toBe(true)
    }
  })

  it('allows clipboard reads on trusted origins right after a gesture', () => {
    for (const url of TRUSTED) expect(allowGuestPermission('clipboard-read', url, FRESH)).toBe(true)
    expect(allowGuestPermission('clipboard-read', TRUSTED[0], GESTURE_WINDOW_MS)).toBe(true)
  })

  it('denies clipboard reads on untrusted origins, gesture or not', () => {
    for (const url of UNTRUSTED) {
      expect(allowGuestPermission('clipboard-read', url, FRESH)).toBe(false)
    }
  })

  it('denies clipboard reads on trusted origins without a recent gesture', () => {
    expect(allowGuestPermission('clipboard-read', TRUSTED[0], GESTURE_WINDOW_MS + 1)).toBe(false)
    expect(allowGuestPermission('clipboard-read', TRUSTED[0], Infinity)).toBe(false)
  })

  it('denies every other permission, even on trusted origins with a gesture', () => {
    for (const p of [
      'deprecated-sync-clipboard-read',
      'geolocation',
      'media',
      'notifications',
      'fullscreen',
      'midiSysex',
      'openExternal',
      'hid',
      'serial',
      'usb',
      'display-capture',
      'pointerLock',
      'idle-detection',
      'local-fonts',
    ]) {
      expect(allowGuestPermission(p, TRUSTED[0], FRESH)).toBe(false)
    }
  })
})

describe('isClipboardReadTrusted', () => {
  it('matches loopback, eCard dev/stage over https, and tailnet hosts only', () => {
    expect(TRUSTED.every(isClipboardReadTrusted)).toBe(true)
    expect(UNTRUSTED.some(isClipboardReadTrusted)).toBe(false)
  })
})
