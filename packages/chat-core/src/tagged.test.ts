import { describe, expect, it } from 'vitest'
import { machineLabel, tagged, untagged } from './tagged'

describe('tagged', () => {
  it('tags plain text on its own first line', () => {
    expect(tagged('hi', 'Mac Mini')).toBe('<surface>Mac Mini - Relay Desktop</surface>\nhi')
  })
  it('names the build and host version after the client, still stripped for display', () => {
    const t = tagged('hi', 'Mac Mini', ' 31e5563 · host 0.2.51')
    expect(t).toBe('<surface>Mac Mini - Relay Desktop 31e5563 · host 0.2.51</surface>\nhi')
    expect(untagged(t)).toBe('hi')
  })
  it('leaves slash commands and blank text untouched', () => {
    expect(tagged('/model x', 'Mac')).toBe('/model x')
    expect(tagged('  /model x', 'Mac')).toBe('  /model x')
    expect(tagged('  ', 'Mac')).toBe('  ')
  })
  it('untagged strips the tag, and older history tagged EvaOS', () => {
    expect(untagged(tagged('hi', 'Mac'))).toBe('hi')
    expect(untagged('<surface>Mac Mini - EvaOS</surface>\nold')).toBe('old')
  })
})

describe('machineLabel', () => {
  const base = { home: '/h', hostname: () => 'box.local' }
  it('prefers the configured label', () => {
    expect(machineLabel({ ...base, readFile: () => ' ECS \n' })).toBe('ECS')
  })
  it('falls back to the short hostname, then Mac', () => {
    expect(machineLabel({ ...base, readFile: () => null })).toBe('box')
    expect(machineLabel({ home: '/h', readFile: () => '', hostname: () => '' })).toBe('Mac')
  })
})
