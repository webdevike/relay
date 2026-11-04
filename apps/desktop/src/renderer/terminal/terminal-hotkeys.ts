import { useEffect } from 'react'
import { registerPageChord } from '../hotkeys/router'
import { revealTool } from '../tiling/tiling-store'

/** Ctrl+` brings the Terminal tab forward from anywhere, like Cmd+P does for Files. */
export function useTerminalHotkeys(): void {
  useEffect(() => {
    const off = registerPageChord('ctrl+`', () => {
      revealTool('terminal')
      return 'consumed'
    })
    return off
  }, [])
}
