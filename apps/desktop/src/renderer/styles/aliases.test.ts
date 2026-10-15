import tokens from './tokens.css?raw'
import { describe, expect, it } from 'vitest'

const css = tokens

describe('tokens.css aliases', () => {
  const phase1: Record<string, string> = {
    '--eva-bg': 'background',
    '--eva-surface': 'secondary-background',
    '--eva-surface-2': 'accent-background',
    '--eva-border': 'border',
    '--eva-text': 'foreground',
    '--eva-text-dim': 'muted-foreground',
    '--eva-accent': 'primary-background',
    '--eva-accent-fg': 'primary-foreground',
    '--eva-ok': 'success-background',
    '--eva-warn': 'warning-background',
    '--eva-danger': 'danger-background',
  }
  it.each(Object.entries(phase1))('%s aliases %s', (name, key) => {
    expect(css).toContain(`${name}: var(--eva-c-${key});`)
  })

  it.each([
    '--eva-chrome',
    '--eva-chrome-text',
    '--eva-chrome-border',
    '--eva-hover',
    '--eva-nav-active-bg',
    '--eva-nav-active-fg',
    '--eva-popover-bg',
    '--eva-popover-fg',
    '--eva-scroll-thumb',
    '--eva-scroll-thumb-hover',
    '--eva-scroll-fade-bg',
  ])('declares %s', (name) => {
    expect(css).toMatch(new RegExp(`${name}: var\\(--eva-c-`))
  })

  it('has no hex color literal outside @font-face', () => {
    const stripped = css.replace(/@font-face\s*{[^}]*}/g, '')
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})
