/** Count open todo rows under `## Open` (port of eva.rs parse_open_todos). */
export function countOpenTodos(text: string): number {
  let inOpen = false
  let count = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '## Open') {
      inOpen = true
      continue
    }
    if (!inOpen) continue
    if (line.startsWith('## ')) break
    if (!line.startsWith('- [ ] ')) continue
    const rest = line.slice('- [ ] '.length)
    const sp = rest.search(/\s/)
    const id = sp < 0 ? rest : rest.slice(0, sp)
    const after = sp < 0 ? '' : rest.slice(sp)
    if (!id.startsWith('T')) continue
    if (/\[[^\]]*\]/.test(after)) count++
  }
  return count
}
