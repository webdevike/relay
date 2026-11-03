/** How long something has run: `now`, `6m`, `2h 5m`, `3d`. */
export function elapsedLabel(at: number, now: number): string {
  const min = Math.floor(Math.max(0, now - at) / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return min % 60 === 0 ? `${h}h` : `${h}h ${min % 60}m`
  return `${Math.floor(h / 24)}d`
}

/** When something finished: `4:29 PM` today, `Oct 26` before. */
export function clockLabel(at: number, now: number): string {
  const d = new Date(at)
  if (d.toDateString() === new Date(now).toDateString()) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** A day, for a ledger's `updated:` date: `Today`, `Yesterday`, `Oct 26`. */
export function dayLabel(at: number, now: number): string {
  const d = new Date(at).toDateString()
  if (d === new Date(now).toDateString()) return 'Today'
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (d === y.toDateString()) return 'Yesterday'
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
