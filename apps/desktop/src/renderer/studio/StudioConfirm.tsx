import { Button, Group, Loader } from '@mantine/core'
import { EvaModal } from '../overlay'
import { creditsLabel as credits } from './studio-assets'

/** A paid job's price as the host quoted it just now, or why there is none. */
export type StudioQuote =
  | { state: 'asking' }
  | { state: 'ready'; credits: number; balance: number | undefined }
  | { state: 'failed'; error: string }

export interface StudioConfirmProps {
  opened: boolean
  /** The paid model's name ("Higgsfield Soul"). */
  backend: string
  /** One job's price. */
  quote: StudioQuote
  /** How many jobs go out at that price each. */
  count: number
  /** Sending the jobs now. */
  busy: boolean
  /** The host's refusal of the confirmed jobs (the price rose, the balance ran out). */
  error: string | null
  onClose: () => void
  /** With one job's credits, as each job confirms them. */
  onConfirm: (credits: number) => void
}

/**
 * Asks before paid jobs: what they cost and the balance before and after. Its primary button is
 * the only way a paid job goes out, with the credits shown here; nothing is remembered for later.
 */
export function StudioConfirm({
  opened,
  backend,
  quote,
  count,
  busy,
  error,
  onClose,
  onConfirm,
}: StudioConfirmProps) {
  const ready = quote.state === 'ready' ? quote : null
  const total = ready ? ready.credits * count : 0
  return (
    <EvaModal
      opened={opened}
      onClose={onClose}
      size={420}
      testid="studio-confirm"
      title={ready ? `Spend ${credits(total)} on ${backend}?` : `Price this ${backend} job`}
    >
      <div className="sl-confirm">
        {quote.state === 'asking' ? (
          <Group gap="xs">
            <Loader size="xs" />
            <span className="sl-dim">Asking {backend} for the price</span>
          </Group>
        ) : quote.state === 'failed' ? (
          <span className="sl-error">{quote.error}</span>
        ) : (
          <dl className="sl-ledger" data-testid="studio-confirm-ledger">
            <dt>{count === 1 ? 'This image' : `${count} images`}</dt>
            <dd data-testid="studio-confirm-cost">{credits(total)}</dd>
            {quote.balance !== undefined ? (
              <>
                <dt>Balance now</dt>
                <dd>{credits(quote.balance)}</dd>
                <dt>Balance after</dt>
                <dd data-testid="studio-confirm-after">{credits(quote.balance - total)}</dd>
              </>
            ) : null}
          </dl>
        )}
        {error ? <span className="sl-error">{error}</span> : null}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            data-testid="studio-confirm-spend"
            disabled={!ready || (ready.balance !== undefined && ready.balance < total)}
            loading={busy}
            onClick={() => ready && onConfirm(ready.credits)}
          >
            {ready ? `Spend ${credits(total)}` : 'Spend'}
          </Button>
        </Group>
      </div>
    </EvaModal>
  )
}
