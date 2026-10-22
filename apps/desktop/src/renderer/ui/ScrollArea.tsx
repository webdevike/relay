import { ScrollArea as MantineScrollArea } from '@mantine/core'
import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react'
import { getScroll, setScroll } from './scroll-memory'
import './scroll.css'

export interface ScrollAreaProps {
  children?: ReactNode
  className?: string
  /** Restores and saves scrollTop under this place key (D-06, SHEL-06). */
  scrollKey?: string
  'data-testid'?: string
}

/** Stock Mantine ScrollArea; the scrollbar gets its own lane, and a scrollKey remembers position. */
export function ScrollArea({
  children,
  className,
  scrollKey,
  'data-testid': testid,
}: ScrollAreaProps) {
  const viewport = useRef<HTMLDivElement>(null)
  const raf = useRef(0)

  useLayoutEffect(() => {
    const el = viewport.current
    if (el && scrollKey) el.scrollTop = getScroll(scrollKey)
  }, [scrollKey])

  const onScroll = useCallback(() => {
    if (!scrollKey) return
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => {
      if (viewport.current) setScroll(scrollKey, viewport.current.scrollTop)
    })
  }, [scrollKey])

  return (
    <div className={`eva-scroll${className ? ` ${className}` : ''}`} data-testid={testid}>
      <MantineScrollArea
        offsetScrollbars="y"
        scrollbarSize={6}
        h="100%"
        viewportRef={viewport}
        onScrollPositionChange={onScroll}
      >
        {children}
      </MantineScrollArea>
    </div>
  )
}
