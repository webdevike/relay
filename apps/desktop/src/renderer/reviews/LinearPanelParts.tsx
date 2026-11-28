import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** A long body shown to a fixed height first; Show more lets the rest out. */
export function Clamped({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = (): void => setOverflows(el.scrollHeight > el.clientHeight + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div
      className="eva-rv-clamp"
      data-open={open || undefined}
      data-overflows={overflows || undefined}
    >
      <div ref={box} className="eva-rv-clamp-body eva-rv-body" data-testid="linear-description">
        {children}
      </div>
      {overflows || open ? (
        <button
          type="button"
          className="eva-rv-lpanel-more"
          onClick={() => setOpen((o) => !o)}
          data-testid="linear-description-more"
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  )
}
