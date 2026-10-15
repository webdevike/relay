import { describe, expect, it } from 'vitest'
import { matchesAppUrl } from './app-url'

const built = { devServerUrl: undefined, rendererDir: '/app/out/renderer' }
const dev = { devServerUrl: 'http://localhost:5173', rendererDir: '/app/out/renderer' }

describe('matchesAppUrl', () => {
  it('accepts the built renderer files and nothing beside them', () => {
    expect(matchesAppUrl('file:///app/out/renderer/index.html', built)).toBe(true)
    expect(matchesAppUrl('file:///app/out/renderer/index.html#/chat', built)).toBe(true)
    expect(matchesAppUrl('file:///app/out/renderer-other/index.html', built)).toBe(false)
    expect(matchesAppUrl('file:///app/out/renderer', built)).toBe(false)
    expect(matchesAppUrl('file:///app/out/index.html', built)).toBe(false)
    expect(matchesAppUrl('file:///etc/hosts', built)).toBe(false)
  })

  it('accepts the dev origin exactly and rejects look-alike hosts', () => {
    expect(matchesAppUrl('http://localhost:5173', dev)).toBe(true)
    expect(matchesAppUrl('http://localhost:5173/', dev)).toBe(true)
    expect(matchesAppUrl('http://localhost:5173/index.html?x=1', dev)).toBe(true)
    expect(matchesAppUrl('http://localhost:5173.evil.example/', dev)).toBe(false)
    expect(matchesAppUrl('http://localhost:51730/', dev)).toBe(false)
    expect(matchesAppUrl('https://localhost:5173/', dev)).toBe(false)
    expect(matchesAppUrl('file:///app/out/renderer/index.html', dev)).toBe(false)
  })

  it('rejects empty, undefined and a malformed dev url', () => {
    expect(matchesAppUrl(undefined, built)).toBe(false)
    expect(matchesAppUrl('', built)).toBe(false)
    expect(matchesAppUrl('http://x/', { ...dev, devServerUrl: 'not a url' })).toBe(false)
  })
})
