import { Badge, Group, Stack, Tabs, Text } from '@mantine/core'
import type { PrSpec, Tone } from '@evaos/chat-core/widget'
import { Markdown } from '../../markdown/Markdown'
import { DiffWidget } from './DiffWidget'
import { LinkIcon, useToneColor } from './parts'

type Check = NonNullable<PrSpec['checks']>[number]
type Reviewer = NonNullable<PrSpec['reviewers']>[number]

const STATE_TONE: Record<PrSpec['state'], Tone> = {
  open: 'ok',
  draft: 'muted',
  merged: 'accent',
  closed: 'danger',
}
const CHECK_TONE: Record<Check['status'], Tone> = {
  success: 'ok',
  failure: 'danger',
  pending: 'warn',
  skipped: 'muted',
}
const REVIEW: Record<Reviewer['state'], [string, Tone]> = {
  approved: ['Approved', 'ok'],
  changes: ['Changes requested', 'danger'],
  commented: ['Commented', 'muted'],
  pending: ['Pending', 'warn'],
}

/** The Checks tab label: failures first, else passed over total (PrCard). */
export function checksLabel(checks: Check[]): string {
  if (checks.length === 0) return 'Checks'
  const failed = checks.filter((c) => c.status === 'failure').length
  if (failed > 0) return `Checks · ${failed} failed`
  const passed = checks.filter((c) => c.status === 'success').length
  return `Checks · ${passed}/${checks.length}`
}

/**
 * A pull request, GitHub-mobile style (relay PrCard): repo, number, state and title up top, author
 * and branch under them, then Overview (markdown body and reviewers), Checks and Files tabs.
 */
export function PrWidget({ spec }: { spec: PrSpec }) {
  const toneColor = useToneColor()
  const checks = spec.checks ?? []
  const files = spec.files ?? []
  const reviewers = spec.reviewers ?? []
  const byline = [
    spec.author,
    spec.branch !== undefined ? `${spec.branch} → ${spec.base ?? 'main'}` : undefined,
  ]
    .filter((s) => s !== undefined)
    .join(' · ')
  const pill = (label: string, tone: Tone) => (
    <Badge size="sm" variant="light" radius="sm" tt="none" color={toneColor(tone)}>
      {label}
    </Badge>
  )
  return (
    <Stack gap="sm" data-testid="widget-pr">
      <Stack gap={4}>
        <Group gap="sm" wrap="nowrap">
          <Text size="xs" c="dimmed" truncate style={{ flex: 1 }}>
            {spec.repo} #{spec.number}
          </Text>
          {pill(spec.state, STATE_TONE[spec.state])}
          {spec.url !== undefined ? <LinkIcon url={spec.url} label="Open pull request" /> : null}
        </Group>
        <Text fw={600}>{spec.title}</Text>
        {byline !== '' ? (
          <Text size="xs" c="dimmed" lineClamp={2}>
            {byline}
          </Text>
        ) : null}
      </Stack>
      <Tabs defaultValue="overview" variant="outline">
        <Tabs.List>
          <Tabs.Tab value="overview">Overview</Tabs.Tab>
          <Tabs.Tab value="checks">{checksLabel(checks)}</Tabs.Tab>
          <Tabs.Tab value="files">Files · {files.length}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="overview" pt="sm">
          <Stack gap="sm">
            {spec.body !== undefined && spec.body.trim() !== '' ? (
              <Markdown text={spec.body} />
            ) : (
              <Text size="sm" c="dimmed">
                No description.
              </Text>
            )}
            {reviewers.length > 0 ? (
              <Stack gap={6} className="eva-w-pr-reviewers">
                <Text size="xs" fw={600}>
                  Reviewers
                </Text>
                {reviewers.map((r) => {
                  const [label, tone] = REVIEW[r.state]
                  return (
                    <Group key={r.name} gap="sm" wrap="nowrap">
                      <Text size="sm" truncate style={{ flex: 1 }}>
                        {r.name}
                      </Text>
                      {pill(label, tone)}
                    </Group>
                  )
                })}
              </Stack>
            ) : null}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="checks" pt="xs">
          {checks.length === 0 ? (
            <Text size="sm" c="dimmed">
              No checks reported.
            </Text>
          ) : (
            checks.map((c, i) => (
              <Group key={`${c.name}-${i}`} gap="sm" wrap="nowrap" className="eva-w-pr-check">
                {pill(c.status, CHECK_TONE[c.status])}
                <Text size="sm" truncate style={{ flex: 1 }}>
                  {c.name}
                </Text>
                {c.duration !== undefined ? (
                  <Text size="xs" c="dimmed" className="eva-w-time">
                    {c.duration}
                  </Text>
                ) : null}
                {c.url !== undefined ? <LinkIcon url={c.url} label="Open check" /> : null}
              </Group>
            ))
          )}
        </Tabs.Panel>
        <Tabs.Panel value="files" pt="sm">
          <Stack gap="sm">
            {files.length === 0 ? (
              <Text size="sm" c="dimmed">
                No file diffs included.
              </Text>
            ) : (
              files.map((f) => (
                <DiffWidget key={f.file} spec={{ widget: 'diff', file: f.file, patch: f.patch }} />
              ))
            )}
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  )
}
