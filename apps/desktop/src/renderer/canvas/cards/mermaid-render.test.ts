import { describe, expect, it } from 'vitest'
import { mermaidTheme, nextMermaidId } from './mermaid-render'

describe('mermaid helpers', () => {
  it('follows the color scheme', () => {
    expect(mermaidTheme('dark')).toBe('dark')
    expect(mermaidTheme('light')).toBe('default')
  })

  it('never repeats an id', () => {
    const a = nextMermaidId()
    const b = nextMermaidId()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[a-z][a-z0-9-]*$/)
  })
})
