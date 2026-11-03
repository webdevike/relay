/**
 * The session id a session file carries in its name: the end of omp's `<time>_<id>.jsonl`, the
 * whole stem of Claude Code's `<uuid>.jsonl`.
 */
export function sessionId(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1)
  const stem = base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base
  const cut = stem.lastIndexOf('_')
  return cut < 0 ? stem : stem.slice(cut + 1)
}
