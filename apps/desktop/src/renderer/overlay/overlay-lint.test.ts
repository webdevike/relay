import { describe, expect, it } from 'vitest'

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
})
