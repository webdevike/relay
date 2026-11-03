import './typing.css'

export interface TypingDotsProps {
  /** Read by screen readers, e.g. "Astra is typing". */
  label: string
  /** `pill` (default) is a chat thread's typing bubble; `inline` sits inside a line of text. */
  size?: 'pill' | 'inline'
}

/** Three dots pulsing in turn. */
export function TypingDots({ label, size = 'pill' }: TypingDotsProps) {
  return (
    <span
      className="eva-typing"
      data-size={size === 'inline' ? 'inline' : undefined}
      role="img"
      aria-label={label}
    >
      <span />
      <span />
      <span />
    </span>
  )
}
