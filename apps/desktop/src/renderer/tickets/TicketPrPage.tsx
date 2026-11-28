// A PR's page inside its ticket (`ticket:<KEY>/pr/<owner>/<repo>/<n>`): the same PrView the Reviews
// page shows, read when the route opens and again on refresh or after a write. The ticket page's
// own status strip (with the stepper over the ticket's PRs) sits above it, so the view's is off;
// each read goes to `onLoaded`, so that strip says what the PR's sidebar says.
import { useCallback, useEffect, useState } from 'react'
import type { ReviewPr } from '@evaos/contract'
import { invoke } from '../ipc'
import { PrView } from '../reviews/PrView'
import type { TicketPrRef } from './ticket-place'
import '../reviews/reviews.css'

export function TicketPrPage({
  pr,
  now,
  onLoaded,
}: {
  pr: TicketPrRef
  now: number
  onLoaded?: (pr: ReviewPr) => void
}) {
  const [loaded, setLoaded] = useState<{ pr: ReviewPr; at: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { repo, number } = pr
  const load = useCallback(async (): Promise<boolean> => {
    setError(null)
    const r = await invoke('reviews.pr', { repo, number })
    if (r.ok) {
      setLoaded({ pr: r.value, at: Date.now() })
      onLoaded?.(r.value)
    } else setError(r.error.message)
    return r.ok
  }, [repo, number, onLoaded])
  useEffect(() => {
    void load()
  }, [load])
  if (!loaded)
    return (
      <div className="eva-tk-dim eva-tk-loading" data-testid="ticket-pr-loading">
        {error ? `Couldn't load ${repo}#${number}: ${error}` : 'Loading the pull request...'}
      </div>
    )
  return (
    <div className="eva-tk-pr eva-rv" data-testid="ticket-pr-page">
      <PrView
        pr={loaded.pr}
        fetchedAt={loaded.at}
        now={now}
        onRefresh={() => void load()}
        onReload={load}
        strip={false}
      />
    </div>
  )
}
