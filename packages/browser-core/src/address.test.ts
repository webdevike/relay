import { describe, expect, it } from 'vitest'
import { normalize } from './address'

const search = (q: string) => `https://www.google.com/search?q=${q}`

describe('normalize', () => {
  it('returns null for empty input', () => {
    expect(normalize('')).toBeNull()
    expect(normalize('   ')).toBeNull()
  })
  it('reads 2 to 5 digit bare ports', () => {
    expect(normalize('3000')).toBe('http://127.0.0.1:3000/')
    expect(normalize('12')).toBe('http://127.0.0.1:12/')
    expect(normalize('7')).toBe(search('7'))
    expect(normalize('123456')).toBe(search('123456'))
  })
  it('keeps typed schemes and loopback hosts', () => {
    expect(normalize('https://x.dev/a')).toBe('https://x.dev/a')
    expect(normalize('http://example.com')).toBe('http://example.com')
    expect(normalize('localhost:5173')).toBe('http://localhost:5173')
    expect(normalize('localhost:5173/app')).toBe('http://localhost:5173/app')
    expect(normalize('127.0.0.1')).toBe('http://127.0.0.1')
    expect(normalize('127.0.0.1:8860')).toBe('http://127.0.0.1:8860')
    expect(normalize('[::1]:8080')).toBe('http://[::1]:8080')
  })
  it('uses https for domain-like input', () => {
    expect(normalize('example.com')).toBe('https://example.com')
    expect(normalize('github.com/zed-industries')).toBe('https://github.com/zed-industries')
    expect(normalize('v1.2')).toBe('https://v1.2')
    expect(normalize('example.')).toBe(search('example.'))
  })
  it('searches for everything else', () => {
    expect(normalize('hello world')).toBe(search('hello+world'))
    expect(normalize('rust gpui docs')).toBe(search('rust+gpui+docs'))
    expect(normalize('a&b c')).toBe(search('a%26b+c'))
  })
})
