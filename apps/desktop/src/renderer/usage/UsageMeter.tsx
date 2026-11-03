import { useEffect, useState } from 'react'
import { Button, Progress, RingProgress, Table, Text, Tooltip, UnstyledButton } from '@mantine/core'
import { IconMinus, IconRefresh } from '@tabler/icons-react'
import { USAGE_PROVIDERS, type UsageAccount } from '@evaos/contract'
import { EvaPopover } from '../overlay'
import { useOccludeBrowser } from '../overlay/overlay-store'
import {
  LEVEL_COLOR,
  PROVIDER_NAME,
  agoLabel,
  mostUsed,
  percent,
  usageLevel,
  windowLevel,
  windowReset,
} from './usage-look'
import { ProviderIcon } from '../brand/ProviderIcon'
import { refreshUsage, useUsage } from './usage-store'
import './usage.css'

/** Re-renders every 30 s while `active`, so relative times stay current. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [active])
  return now
}

function staleNote(a: UsageAccount, now: number): string | null {
  if (!a.stale || a.fetchedAt === null) return null
  return `Last good data from ${agoLabel(a.fetchedAt, now)}. ${a.error ?? ''}`.trim()
}

function AccountTip({ account: a }: { account: UsageAccount }) {
  const now = useNow(true)
  const stale = staleNote(a, now)
  return (
    <div className="eva-usage-tip" data-testid="usage-tooltip">
      <div className="eva-usage-tip-title">
        {PROVIDER_NAME[a.provider]} {a.profileLabel}
      </div>
      {a.windows.length === 0 ? (
        <div>{a.error ?? 'No usage data yet'}</div>
      ) : (
        <div className="eva-usage-tip-grid">
          {a.windows.map((w) => (
            <div key={w.id} className="eva-usage-tip-row">
              <span>{w.label}</span>
              <span className="eva-usage-num">{percent(w)}%</span>
              <span>{windowReset(w, now)}</span>
            </div>
          ))}
        </div>
      )}
      {stale ? <div className="eva-usage-tip-note">{stale}</div> : null}
    </div>
  )
}

function AccountItem({
  account: a,
  tipsOff,
  onOpen,
}: {
  account: UsageAccount
  tipsOff: boolean
  onOpen: () => void
}) {
  const [hover, setHover] = useState(false)
  const tip = hover && !tipsOff
  // The tooltip rises over the side panel, whose native browser view would cover it.
  useOccludeBrowser(tip)
  const top = mostUsed(a.windows)
  const level = usageLevel(a)
  const name = `${PROVIDER_NAME[a.provider]} ${a.profileLabel}`
  return (
    <Tooltip label={<AccountTip account={a} />} opened={tip} position="top-end" withinPortal>
      <UnstyledButton
        className="eva-usage-item"
        data-testid={`usage-item-${a.key}`}
        data-level={level}
        data-stale={a.stale ? 'true' : undefined}
        aria-label={top ? `${name}, ${percent(top)}% used` : `${name}, no usage data`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        onClick={onOpen}
      >
        <span className="eva-usage-profile">{a.profileLabel.charAt(0)}</span>
        {top ? (
          <>
            <RingProgress
              size={14}
              thickness={2}
              roundCaps
              rootColor="var(--eva-c-border)"
              sections={[{ value: Math.min(100, percent(top)), color: LEVEL_COLOR[level] }]}
            />
            <span className="eva-usage-num" data-testid="usage-pct">
              {percent(top)}%
            </span>
          </>
        ) : (
          <IconMinus size={12} stroke={1.5} className="eva-usage-none" data-testid="usage-none" />
        )}
      </UnstyledButton>
    </Tooltip>
  )
}

function AccountDetail({ account: a, now }: { account: UsageAccount; now: number }) {
  const stale = staleNote(a, now)
  return (
    <section className="eva-usage-detail" data-testid={`usage-detail-${a.key}`}>
      <div className="eva-usage-detail-head">
        <Text size="sm" fw={600}>
          {PROVIDER_NAME[a.provider]} {a.profileLabel}
        </Text>
        {a.email ? (
          <Text size="xs" c="dimmed" truncate>
            {a.email}
          </Text>
        ) : null}
      </div>
      {a.windows.length === 0 ? (
        <Text size="xs" c="dimmed">
          {a.error ?? 'No usage data yet'}
        </Text>
      ) : (
        <Table
          className="eva-usage-table"
          withRowBorders={false}
          verticalSpacing={2}
          horizontalSpacing={0}
        >
          <Table.Tbody>
            {a.windows.map((w) => (
              <Table.Tr key={w.id}>
                <Table.Td className="eva-usage-label">{w.label}</Table.Td>
                <Table.Td className="eva-usage-bar">
                  <Progress
                    size="sm"
                    value={Math.min(100, percent(w))}
                    color={LEVEL_COLOR[windowLevel(w)]}
                    aria-label={`${w.label} used`}
                  />
                </Table.Td>
                <Table.Td className="eva-usage-num" ta="right">
                  {percent(w)}%
                </Table.Td>
                <Table.Td className="eva-usage-reset">{windowReset(w, now)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {stale ? (
        <Text size="xs" c="dimmed">
          {stale}
        </Text>
      ) : null}
    </section>
  )
}

/** Footer meter: Claude and Codex usage for each omp profile; click for every window. */
export function UsageMeter() {
  const snapshot = useUsage((s) => s)
  const [open, setOpen] = useState(false)
  const now = useNow(open)
  if (!snapshot || snapshot.accounts.length === 0) return null
  return (
    // EvaPopover's testid lands on its target, the meter.
    <EvaPopover
      opened={open}
      onChange={setOpen}
      position="top-end"
      width={400}
      testid="usage-meter"
    >
      <EvaPopover.Target>
        <div className="eva-usage">
          {USAGE_PROVIDERS.map((provider) => {
            const accounts = snapshot.accounts.filter((a) => a.provider === provider)
            if (accounts.length === 0) return null
            return (
              <div key={provider} className="eva-usage-group">
                <span className="eva-usage-provider">
                  <ProviderIcon provider={provider} />
                </span>
                {accounts.map((a) => (
                  <AccountItem
                    key={a.key}
                    account={a}
                    tipsOff={open}
                    onOpen={() => setOpen((o) => !o)}
                  />
                ))}
              </div>
            )
          })}
        </div>
      </EvaPopover.Target>
      <EvaPopover.Dropdown>
        <div className="eva-usage-pop" data-testid="usage-popover">
          {snapshot.accounts.map((a) => (
            <AccountDetail key={a.key} account={a} now={now} />
          ))}
          <div className="eva-usage-pop-foot">
            <Text size="xs" c="dimmed" data-testid="usage-updated">
              {snapshot.updatedAt === null
                ? 'Not updated yet'
                : `Updated ${agoLabel(snapshot.updatedAt, now)}`}
            </Text>
            <Button
              size="compact-xs"
              variant="default"
              leftSection={<IconRefresh size={14} stroke={1.5} />}
              loading={snapshot.refreshing}
              onClick={() => void refreshUsage()}
              data-testid="usage-refresh"
            >
              Refresh
            </Button>
          </div>
        </div>
      </EvaPopover.Dropdown>
    </EvaPopover>
  )
}
