import { describe, expect, it } from 'vitest'

/**
 * Every scrollbar looks like Mantine's ScrollArea (styles/tokens.css). Chromium skips the global
 * ::-webkit-scrollbar rules on any element that sets scrollbar-width or scrollbar-color, so a
 * component may only hide its bar (scrollbar-width: none), never restyle it.
 */
describe('one scrollbar style', () => {
  it('no component CSS sets its own scrollbar width or color', () => {
    const files = import.meta.glob('../**/*.css', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>
    const offenders: string[] = []
    for (const [file, css] of Object.entries(files)) {
      for (const m of css.matchAll(/scrollbar-(width|color)\s*:\s*([^;]+);/g)) {
        if (m[1] === 'width' && m[2]!.trim() === 'none') continue
        offenders.push(`${file}: ${m[0]}`)
      }
    }
    expect(Object.keys(files).length).toBeGreaterThan(10)
    expect(offenders).toEqual([])
  })
})
