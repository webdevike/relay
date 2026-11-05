/** A key press, as much of it as `/` needs. */
export interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  defaultPrevented: boolean
  target: EventTarget | null
}

const FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable=false])'

/**
 * Whether this press is "write a comment" for the live room: a bare `/` that no field or earlier
 * handler took. The room page handles it itself when its frame has focus; this app catches it when
 * focus sits anywhere else (the header, the sidebar, nothing), where the page never hears it.
 */
export function isCommentKey(e: KeyLike): boolean {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return false
  const t = e.target
  return !(t instanceof Element && t.closest(FIELD) !== null)
}
