import * as path from 'node:path'
import stylelint from 'stylelint'
import { describe, expect, it } from 'vitest'
import { compare } from './lint-spacing'

const CONFIG = path.resolve(import.meta.dirname, '../stylelint.config.mjs')

async function disallowed(css: string): Promise<string[]> {
  const r = await stylelint.lint({ code: css, configFile: CONFIG })
  return r.results[0]!.warnings.map((w) => w.text)
}

describe('spacing rule', () => {
  it('allows 0, Mantine spacing, its fractions and var(--eva-gap)', async () => {
    const ok = [
      'padding: 0',
      'padding: var(--mantine-spacing-xs) var(--mantine-spacing-sm)',
      'gap: calc(var(--mantine-spacing-xs) / 2)',
      'margin: 0 auto',
      'margin-top: calc(-1 * var(--mantine-spacing-md))',
      'padding-inline-start: var(--mantine-spacing-lg)',
      'column-gap: var(--eva-gap)',
    ]
    expect(await disallowed(`a { ${ok.join('; ')} }`)).toEqual([])
  })
  it('rejects raw lengths and other tokens on every spacing property', async () => {
    const bad = [
      'gap: 1px',
      'padding: var(--eva-space-xs)',
      'margin: 0 0 4px',
      'row-gap: 2px',
      'padding-left: 26px',
      'margin-block-end: 1rem',
    ]
    expect(await disallowed(`a { ${bad.join('; ')} }`)).toHaveLength(bad.length)
  })
})

describe('baseline', () => {
  const chat = 'apps/desktop/src/renderer/chat/list/chat-list.css'
  const shell = 'apps/desktop/src/renderer/shell/shell.css'
  it('passes when the violations match the baseline', () => {
    const c = { [shell]: { 'gap: 4px': 2 } }
    expect(compare(c, c)).toEqual({ strict: [], added: [], stale: [] })
  })
  it('fails a new violation and a stale entry', () => {
    const v = compare(
      { [shell]: { 'gap: 4px': 3, 'padding: 1px': 1 } },
      { [shell]: { 'gap: 4px': 2, 'margin: 2px': 1 } },
    )
    expect(v.added).toEqual([
      `${shell}: gap: 4px (3, baseline 2)`,
      `${shell}: padding: 1px (1, baseline 0)`,
    ])
    expect(v.stale).toEqual([`${shell}: margin: 2px (baseline 1, now 0)`])
  })
  it('never lets the chat list carry a violation, baseline or not', () => {
    const c = { [chat]: { 'gap: 1px': 1 } }
    expect(compare(c, c).strict).toEqual([`${chat}: gap: 1px`])
  })
})
