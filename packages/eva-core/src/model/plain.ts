/** Port of eva.rs plain: strips emphasis, code ticks and link targets. */
export function plain(markdown: string): string {
  let out = ''
  const chars = Array.from(markdown)
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!
    if (c === '*' || c === '`' || c === '[') continue
    if (c === ']' && chars[i + 1] === '(') {
      // drop the target through the next ')'
      i++
      while (i + 1 < chars.length) {
        i++
        if (chars[i] === ')') break
      }
      continue
    }
    out += c
  }
  return out.trim()
}

/** Port of eva.rs display_name: cut at the first em dash with spaces, then at " (". */
export function displayName(h1: string): string {
  let name = h1.split(' \u2014 ')[0] ?? h1
  name = name.split(' (')[0] ?? name
  return name.trim()
}

/** Tagline from an already joined paragraph (second half of eva.rs tagline). */
export function taglineOf(paragraph: string): string {
  let t = paragraph.trim()
  while (t.startsWith('- ')) t = t.slice(2)
  let text = plain(t)
  const split = text.indexOf(': ')
  if (split >= 0) {
    const label = text.slice(0, split)
    if (label.length <= 12 && !label.includes(' ')) text = text.slice(split + 2)
  }
  const end = text.indexOf('. ')
  return end >= 0 ? text.slice(0, end + 1).trim() : text
}

/** Port of eva.rs tagline: first sentence of the first prose paragraph under the title. */
export function tagline(text: string): string {
  const lines = text.split(/\r?\n/)
  const h1 = lines.findIndex((l) => l.startsWith('# '))
  if (h1 < 0) return ''
  const para: string[] = []
  let started = false
  for (const raw of lines.slice(h1 + 1)) {
    const line = raw.trim()
    if (!started) {
      if (line === '') continue
      started = true
    }
    if (line === '' || line.startsWith('#') || line.startsWith('|')) break
    para.push(line)
  }
  return taglineOf(para.join(' '))
}
