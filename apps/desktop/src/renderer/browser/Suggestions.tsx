import { useOccludeBrowser } from '../overlay/overlay-store'

export interface SuggestionItem {
  url: string
  title: string
}

export function Suggestions({
  items,
  active,
  onPick,
}: {
  items: SuggestionItem[]
  active: number
  onPick(item: SuggestionItem): void
}) {
  const open = items.length > 0
  // The native browser view would cover the list, so it hides while the list shows (D-08).
  useOccludeBrowser(open)
  if (!open) return null
  return (
    <div className="eva-suggestions" data-testid="suggestions" role="listbox">
      {items.map((it, i) => (
        <div
          key={it.url}
          role="option"
          aria-selected={i === active}
          data-testid="suggestion-row"
          className={`eva-suggestion${i === active ? ' is-active' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(it)
          }}
        >
          <span className="eva-label eva-suggestion-title">{it.title || it.url}</span>
          <span className="eva-label eva-suggestion-url">
            {it.url.replace(/^[a-z]+:\/\/(www\.)?/, '').replace(/\/$/, '')}
          </span>
        </div>
      ))}
    </div>
  )
}
