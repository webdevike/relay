import { ScrollArea as MantineScrollArea } from '@mantine/core'
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { getScroll, setScroll } from './scroll-memory'
import './scroll.css'

export interface ScrollAreaProps {
  children?: ReactNode
  className?: string
  fadeBg?: string
  /** Restores and saves scrollTop under this place key (D-06, SHEL-06). */
  scrollKey?: string
  'data-testid'?: string
}

export function ScrollArea({
  children,
  className,
  fadeBg = 'var(--eva-c-background, var(--eva-bg))',
  scrollKey,
  'data-testid': testid,
}: ScrollAreaProps) {
  const viewport = useRef<HTMLDivElement>(null)
  const raf = useRef(0)
  const [fade, setFade] = useState({ top: false, bottom: false })

  const measure = useCallback(() => {
    const el = viewport.current
    if (!el) return
    const overflow = el.scrollHeight > el.clientHeight + 1
    const top = overflow && el.scrollTop > 0
    const bottom = overflow && el.scrollTop + el.clientHeight < el.scrollHeight - 1
    setFade((f) => (f.top === top && f.bottom === bottom ? f : { top, bottom }))
  }, [])

  useLayoutEffect(() => {
    const el = viewport.current
    if (!el) return
    if (scrollKey) el.scrollTop = getScroll(scrollKey)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [scrollKey, measure])

  const onScroll = useCallback(() => {
    measure()
    if (!scrollKey) return
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => {
      if (viewport.current) setScroll(scrollKey, viewport.current.scrollTop)
    })
  }, [measure, scrollKey])

  return (
    <div
      className={`eva-scroll${className ? ` ${className}` : ''}`}
      style={{ '--eva-scroll-fade-bg': fadeBg } as React.CSSProperties}
      data-fade-top={fade.top ? 'true' : 'false'}
      data-fade-bottom={fade.bottom ? 'true' : 'false'}
      data-testid={testid}
    >
      <MantineScrollArea
        type="hover"
        scrollbarSize={8}
        offsetScrollbars={false}
        h="100%"
        viewportRef={viewport}
        onScrollPositionChange={onScroll}
        classNames={{
          viewport: 'eva-scroll-viewport',
          scrollbar: 'eva-scroll-scrollbar',
          thumb: 'eva-scroll-thumb',
        }}
        styles={{ viewport: { overscrollBehavior: 'contain' } }}
      >
        {children}
      </MantineScrollArea>
      <div className="eva-scroll-fade eva-scroll-fade-top" aria-hidden />
      <div className="eva-scroll-fade eva-scroll-fade-bottom" aria-hidden />
    </div>
  )
}
