// The SKILL.md document schema. The Relay host builds the same ProseMirror schema headless
// (apps/linux), else the Yjs sync silently drops nodes it cannot place, so this list is exactly
// proof/skills-page/CONTRACT.md section 1. Editor-only extensions (collaboration, carets,
// placeholder) stay out of it.
import { Node, type Extensions } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Code from '@tiptap/extension-code'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem, TaskList } from '@tiptap/extension-list'

/** Markdown the editor cannot represent faithfully, kept verbatim and edited as plain monospace. */
export const RawMarkdown = Node.create({
  name: 'rawMarkdown',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  parseHTML: () => [{ tag: 'pre[data-raw-markdown]', preserveWhitespace: 'full' }],
  renderHTML: () => ['pre', { 'data-raw-markdown': '' }, ['code', 0]],
})

export function skillSchemaExtensions(): Extensions {
  return [
    StarterKit.configure({ undoRedo: false, trailingNode: false, underline: false, code: false }),
    // `**`code`**` is common in Isaac's skills.
    Code.extend({ excludes: '' }),
    TableKit,
    TaskList,
    TaskItem.configure({ nested: true }),
    RawMarkdown,
  ]
}
