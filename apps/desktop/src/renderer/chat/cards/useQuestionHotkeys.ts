import { useEffect, useRef } from 'react'
import { registerPageChord } from '../../hotkeys/router'

/** Keys 1 to 4 pick option 1 to 4 while a question is pending. The router drops them in inputs and the terminal. */
export function useQuestionHotkeys(active: boolean, onPick: (index: number) => boolean): void {
  const pick = useRef(onPick)
  pick.current = onPick
  useEffect(() => {
    if (!active) return
    const offs = [0, 1, 2, 3].map((i) =>
      registerPageChord(String(i + 1), () => (pick.current(i) ? 'consumed' : false)),
    )
    return () => offs.forEach((off) => off())
  }, [active])
}
