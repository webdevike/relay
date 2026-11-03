import { useEffect, useRef, useState } from 'react'
import { DISMISS_PRIORITY, useDismissable } from '../../hotkeys/dismiss'

export interface CategoryInputProps {
  initial?: string
  /** Resolves to the Rust error string when the name is rejected, else null (input closes). */
  onSubmit: (name: string) => Promise<string | null>
  onCancel: () => void
}

/** Inline name field for a new or renamed category: Enter commits, Esc cancels, errors stay inline. */
export function CategoryInput({ initial = '', onSubmit, onCancel }: CategoryInputProps) {
  const ref = useRef<HTMLInputElement>(null)
  const ready = useRef(false)
  const done = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // The menu that opened this may hand focus back to its anchor as it closes.
    const focus = (): void => {
      ref.current?.focus()
      ref.current?.select()
    }
    focus()
    const t1 = setTimeout(focus, 120)
    const t2 = setTimeout(() => {
      ready.current = true
    }, 250)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [])

  const cancel = (): void => {
    if (done.current) return
    done.current = true
    onCancel()
  }
  const submit = async (): Promise<void> => {
    if (busy || done.current) return
    setBusy(true)
    const err = await onSubmit(ref.current?.value ?? '')
    setBusy(false)
    if (err === null) {
      done.current = true
    } else {
      setError(err)
      ref.current?.focus()
    }
  }
  useDismissable(DISMISS_PRIORITY.overlay, cancel)

  return (
    <div className="eva-cl-catinput">
      <input
        ref={ref}
        className="eva-cl-rename"
        data-testid="category-input"
        aria-label="Category name"
        aria-invalid={error !== null}
        defaultValue={initial}
        readOnly={busy}
        maxLength={60}
        placeholder="Category name"
        onChange={() => setError(null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void submit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            cancel()
          }
        }}
        onBlur={() => {
          if (ready.current && error === null) cancel()
        }}
      />
      {error ? (
        <div role="alert" className="eva-cl-row-error" data-testid="category-error">
          {error}
        </div>
      ) : null}
    </div>
  )
}
