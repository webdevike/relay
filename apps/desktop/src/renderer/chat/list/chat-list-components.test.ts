import { describe, expect, it } from 'vitest'

/**
 * The chat list draws its clickable surfaces with Mantine, so spacing, focus rings and ARIA come
 * from one place: rows are NavLink, folder headers and the Snoozed / Settled folds are
 * Accordion.Control, small actions are ActionIcon or UnstyledButton. A hand-made <button> or a
 * div posing as one (role button / treeitem / tree) is what let headers and rows paint into each
 * other and folders ignore their clicks. Tests and the hover card's content are out of scope.
 */
const RAW = [
  { what: 'raw <button>', re: /<button[\s>]/g },
  { what: 'role="button"', re: /role=(?:"button"|'button'|\{['"]button['"]\})/g },
  { what: 'role="treeitem"', re: /role=(?:"treeitem"|'treeitem'|\{['"]treeitem['"]\})/g },
  { what: 'role="tree"', re: /role=(?:"tree"|'tree'|\{['"]tree['"]\})/g },
]

/** Returns one line per raw clickable in `src`. */
export function rawClickables(src: string): string[] {
  const found: string[] = []
  for (const { what, re } of RAW) {
    for (const m of src.matchAll(re)) {
      found.push(`${what} at line ${src.slice(0, m.index).split('\n').length}`)
    }
  }
  return found
}

const files = import.meta.glob('./*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const source = (name: string): string => files[`./${name}`] ?? ''

describe('chat list components', () => {
  it('catches raw buttons and fake roles', () => {
    expect(rawClickables('<button type="button" />\n<div role="treeitem" />')).toEqual([
      'raw <button> at line 1',
      'role="treeitem" at line 2',
    ])
    expect(rawClickables('<NavLink component="div" />')).toEqual([])
  })

  it('no chat list component renders a raw clickable', () => {
    const offenders: string[] = []
    for (const [rel, src] of Object.entries(files)) {
      if (/\.test\.tsx$/.test(rel)) continue
      for (const hit of rawClickables(src)) offenders.push(`${rel}: ${hit}`)
    }
    expect(Object.keys(files).length).toBeGreaterThan(5)
    expect(offenders).toEqual([])
  })

  it('rows are NavLink and folders are Accordion items', () => {
    expect(source('ChatRow.tsx')).toMatch(/<NavLink[\s>]/)
    expect(source('GroupHeader.tsx')).toMatch(/<Accordion\.Control[\s>]/)
    expect(source('ChatList.tsx')).toMatch(/<Accordion[\s>]/)
    expect(source('ChatList.tsx')).toMatch(/<Accordion\.Panel[\s>]/)
  })
})
