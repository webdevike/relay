import { getSchema } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { skillSchemaExtensions } from './skill-schema'

describe('skill schema', () => {
  it('has exactly the nodes and marks of the host contract', () => {
    const schema = getSchema(skillSchemaExtensions())
    expect(Object.keys(schema.nodes).sort()).toEqual(
      'blockquote bulletList codeBlock doc hardBreak heading horizontalRule listItem orderedList paragraph rawMarkdown table tableCell tableHeader tableRow taskItem taskList text'.split(
        ' ',
      ),
    )
    expect(Object.keys(schema.marks).sort()).toEqual(['bold', 'code', 'italic', 'link', 'strike'])
  })

  it('lets code sit inside bold', () => {
    const schema = getSchema(skillSchemaExtensions())
    expect(schema.marks.code!.excludes(schema.marks.bold!)).toBe(false)
  })
})
