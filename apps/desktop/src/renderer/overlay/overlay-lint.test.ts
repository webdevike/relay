import { describe, expect, it } from 'vitest'
import { TOAST_HOST_CLASS } from './toast-holes'

const BANNED = ['Modal', 'Menu', 'Popover', 'Drawer']

/** Returns the banned names imported from '@mantine/core' in `src` (handles multi-line imports). */
export function bannedMantineImports(src: string): string[] {
  const found: string[] = []
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@mantine\/core['"]/g
  for (const m of src.matchAll(re)) {
    for (const part of m[1]!.split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]!
        .trim()
      if (BANNED.includes(name)) found.push(name)
    }
  }
  return found
}

describe('overlay import lint (D-13)', () => {
  it('catches multi-line imports', () => {
    const fixture = "import {\n  Button,\n  Modal,\n  Menu as M,\n} from '@mantine/core'"
    expect(bannedMantineImports(fixture)).toEqual(['Modal', 'Menu'])
    expect(bannedMantineImports("import { Button } from '@mantine/core'")).toEqual([])
  })

  it('no renderer file outside overlay imports Modal, Menu, Popover or Drawer from Mantine', () => {
    const files = import.meta.glob('../**/*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>
    const offenders: string[] = []
    for (const [rel, src] of Object.entries(files)) {
      if (rel.startsWith('./') || /\.test\.(ts|tsx)$/.test(rel)) continue
      const bad = bannedMantineImports(src)
      if (bad.length) offenders.push(`${rel}: ${bad.join(', ')}`)
    }
    expect(Object.keys(files).length).toBeGreaterThan(10)
    expect(offenders).toEqual([])
  })

  it('toasts come from one <Notifications> host that main.tsx tells main about', () => {
    // A native browser view paints over the page, so a toast stays visible only because
    // startToastHoles reports its rect and main moves the view's edge away from it.
    const files = import.meta.glob('../**/*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>
    const hosts = Object.entries(files)
      .filter(([rel, src]) => !/\.test\.(ts|tsx)$/.test(rel) && /<Notifications\s/.test(src))
      .map(([rel]) => rel)
    expect(hosts).toEqual(['../main.tsx'])
    const main = files['../main.tsx']!
    expect(main).toContain(`className="${TOAST_HOST_CLASS}"`)
    expect(main).toMatch(/startToastHoles\(\)/)
  })
})
