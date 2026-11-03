import { describe, expect, it } from 'vitest'
import { findEmDashes } from './lint-em-dash'

const D = String.fromCharCode(0x2014)

describe('findEmDashes', () => {
  it('hits string literals', () => {
    expect(findEmDashes('a.ts', `const s = 'a ${D} b'`)).toHaveLength(1)
  })
  it('hits no-substitution templates and template parts', () => {
    expect(findEmDashes('a.ts', 'const s = `a ' + D + ' b`')).toHaveLength(1)
    expect(
      findEmDashes('a.ts', 'const s = `a ' + D + ' ${x} b ' + D + ' ${y} c ' + D + '`'),
    ).toHaveLength(3)
  })
  it('hits JSX text', () => {
    expect(findEmDashes('a.tsx', `const x = <p>a ${D} b</p>`)).toHaveLength(1)
  })
  it('hits JSX attribute string values', () => {
    expect(findEmDashes('a.tsx', `const x = <p title="a ${D} b" />`)).toHaveLength(1)
  })
  it('ignores line comments', () => {
    expect(findEmDashes('a.ts', `// a ${D} b\nconst s = 1`)).toHaveLength(0)
  })
  it('ignores block comments', () => {
    expect(findEmDashes('a.ts', `/* a ${D} b */ const s = 1`)).toHaveLength(0)
  })
  it('reports the line number', () => {
    expect(findEmDashes('a.ts', `const a = 1\nconst s = '${D}'`)[0]?.line).toBe(2)
  })
})
