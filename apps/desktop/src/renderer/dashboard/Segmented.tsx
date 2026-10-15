import { useRef, type KeyboardEvent } from 'react'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  testid: string
  count?: number
}

/** Radiogroup of pills with arrow-key roving (UI-SPEC Interaction States). */
export function Segmented<T extends string>(p: {
  options: SegmentedOption<T>[]
  value: T
  onChange: (v: T) => void
  label: string
  testid: string
  className?: string
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const onKey = (e: KeyboardEvent, i: number): void => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0
    if (!step) return
    e.preventDefault()
    const n = (i + step + p.options.length) % p.options.length
    p.onChange(p.options[n]!.value)
    refs.current[n]?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label={p.label}
      className={`eva-dash-chips ${p.className ?? ''}`}
      data-testid={p.testid}
    >
      {p.options.map((o, i) => {
        const on = o.value === p.value
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className="eva-dash-chip"
            data-selected={on}
            data-testid={o.testid}
            onClick={() => p.onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {o.label}
            {o.count === undefined ? null : (
              <span className="eva-dash-chip-count">{` ${o.count}`}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
