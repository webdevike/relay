import { Kbd } from '@mantine/core'
import { IconSearch } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { useDismissable } from '../hotkeys/dismiss'
import { registerSearchFocuser } from './nav-level'

export interface SearchBoxProps {
  value: string
  onChange: (v: string) => void
  placeholder: string
  testid: string
  /** True for the box on the visible sidebar page; it receives Cmd+F. */
  active: boolean
  showKbd?: boolean
}

export function SearchBox({
  value,
  onChange,
  placeholder,
  testid,
  active,
  showKbd = true,
}: SearchBoxProps) {
  const ref = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!active) return
    return registerSearchFocuser(() => {
      ref.current?.focus()
      ref.current?.select()
    })
  }, [active])

  // Esc: clear a non-empty box first, then blur (D-12).
  useDismissable(
    20,
    () => {
      if (value) onChange('')
      else ref.current?.blur()
    },
    focused,
  )

  return (
    <label className="eva-sb-search">
      <IconSearch size={14} aria-hidden />
      <input
        ref={ref}
        data-testid={testid}
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.currentTarget.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      {showKbd && !value ? <Kbd size="xs">⌘F</Kbd> : null}
    </label>
  )
}
