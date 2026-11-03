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
  /** The paid backend's name ("Higgsfield"). */
  backend: string
  quote: StudioQuote
  /** Sending the job now. */
  busy: boolean
  /** The host's refusal of the confirmed job (the price rose, the balance ran out). */
  error: string | null
  onClose: () => void
  onConfirm: (credits: number) => void
}

/**
 * Asks before a paid job: what it costs and the balance before and after. Its primary button is
 * the only way a paid job goes out, with the credits shown here; nothing is remembered for later.
 */
export function StudioConfirm({
  opened,
  backend,
  quote,
  busy,
  error,
  onClose,
  onConfirm,
}: StudioConfirmProps) {
  const ready = quote.state === 'ready' ? quote : null
  return (
    <EvaModal
      opened={opened}
      onClose={onClose}
      size={420}
      testid="studio-confirm"
      title={ready ? `Spend ${credits(ready.credits)} on ${backend}?` : `Price this ${backend} job`}
    >
      <div className="eva-studio-confirm">
        {quote.state === 'asking' ? (
          <Group gap="xs">
            <Loader size="xs" />
            <span className="eva-studio-faint">Asking {backend} for the price</span>
          </Group>
        ) : quote.state === 'failed' ? (
          <span className="eva-studio-error">{quote.error}</span>
        ) : (
          <dl className="eva-studio-ledger" data-testid="studio-confirm-ledger">
            <dt>This job</dt>
            <dd data-testid="studio-confirm-cost">{credits(quote.credits)}</dd>
            {quote.balance !== undefined ? (
              <>
                <dt>Balance now</dt>
                <dd>{credits(quote.balance)}</dd>
                <dt>Balance after</dt>
                <dd data-testid="studio-confirm-after">{credits(quote.balance - quote.credits)}</dd>
              </>
            ) : null}
          </dl>
        )}
        {error ? <span className="eva-studio-error">{error}</span> : null}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            data-testid="studio-confirm-spend"
            disabled={!ready || (ready.balance !== undefined && ready.balance < ready.credits)}
            loading={busy}
            onClick={() => ready && onConfirm(ready.credits)}
          >
            {ready ? `Spend ${credits(ready.credits)}` : 'Spend'}
          </Button>
        </Group>
      </div>
    </EvaModal>
  )
}
