import { describe, expect, it } from 'vitest'

/**
 * Mantine components stay stock: renderer CSS may not reach into a component's internals with
 * `.mantine-*` class selectors. The look comes from the theme (theme/theme-config.tsx), so every
 * preset applies everywhere. Older uses are listed here and may only shrink.
 */
const ALLOWED: Record<string, number> = {
  // Texo's theme inspector lays each label beside its input (theme-controls.module.css).
  './settings/settings.css': 12,
}

const SELECTOR = /\.mantine-[A-Za-z]+/g

describe('stock Mantine components', () => {
  it('no CSS restyles Mantine internals beyond the shrinking allowlist', () => {
    const files = import.meta.glob('../**/*.css', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>
    const found: Record<string, number> = {}
    for (const [file, css] of Object.entries(files)) {
      const n = css.match(SELECTOR)?.length ?? 0
      if (n > 0) found[file.replace(/^\.\.\//, './')] = n
    }
    expect(Object.keys(files).length).toBeGreaterThan(10)
    // Equal, not at most: a fix must also lower the allowance, so it can never creep back.
    expect(found).toEqual(ALLOWED)
  })
})
