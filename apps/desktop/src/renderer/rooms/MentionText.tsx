import { Fragment } from 'react'
import { mentionSpans } from '@evaos/contract'
import type { Mentionable } from '@relay/canvas-live/mentions'
import '../chat/composer/composer.css'

/** Isaac's text with the @mentions of `people` as the composer's chips; anything else stays plain. */
export function MentionText({ text, people }: { text: string; people: readonly Mentionable[] }) {
  let at = 0
  const parts = mentionSpans(text, people).map((s) => {
    const before = text.slice(at, s.start)
    at = s.end
    return (
      <Fragment key={s.start}>
        {before}
        <span className="eva-at-chip">{text.slice(s.start, s.end)}</span>
      </Fragment>
    )
  })
  return (
    <>
      {parts}
      {text.slice(at)}
    </>
  )
}
