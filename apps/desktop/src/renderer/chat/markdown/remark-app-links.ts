import { parseAppLink } from '@evaos/chat-core/widget'

// GFM autolinks only http(s) and www; a bare relay:// URL in a reply (an agent pasting what `link`
// answered) becomes a link here too, so it renders as the in-app link button.

interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

const BARE = /relay:\/\/[^\s<>()[\]{}"'`]+/g

/** `text` split into text and link nodes for each relay:// link that parses; null when it has none. */
export function splitAppLinks(text: string): MdNode[] | null {
  const out: MdNode[] = []
  let last = 0
  for (const m of text.matchAll(BARE)) {
    // Sentence punctuation after a link is not part of it.
    const url = m[0].replace(/[.,;:!?]+$/, '')
    if (parseAppLink(url) === null) continue
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) })
    out.push({ type: 'link', url, children: [{ type: 'text', value: url }] })
    last = m.index + url.length
  }
  if (out.length === 0) return null
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) })
  return out
}

function walk(node: MdNode): void {
  if (!node.children || node.type === 'link' || node.type === 'linkReference') return
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text' && child.value?.includes('relay://')) {
      return splitAppLinks(child.value) ?? [child]
    }
    walk(child)
    return [child]
  })
}

/** remark plugin: bare relay:// URLs in text become links (code spans and blocks are left alone). */
export function remarkAppLinks() {
  return (tree: MdNode): void => walk(tree)
}
