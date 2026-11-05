import type { ReactNode } from 'react'
import { Button, Group, Radio, Select, SimpleGrid, Switch, Text, TextInput } from '@mantine/core'
import type { SkillAssistant, SkillDetail, SkillRow } from '@evaos/contract'
import { AgentPortrait } from '../assistants/AgentPortrait'
import '../settings/settings.css'
import {
  accessChange,
  joinTitles,
  lastUsedLabel,
  scopeAccess,
  scopeOf,
  sharedProfiles,
  sizeLabel,
  type SkillScope,
} from './skills-model'
import { setSkillAccess } from './skills-store'

interface SkillSettingsProps {
  row: SkillRow
  /** Null while it loads. */
  detail: SkillDetail | null
  assistants: readonly SkillAssistant[]
  now: number
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="eva-skills-section">
      <h3 className="eva-skills-label">{title}</h3>
      {children}
    </section>
  )
}

function ScopeCard({
  title,
  help,
  checked,
  disabled,
  testid,
  onPick,
}: {
  title: string
  help: string
  checked: boolean
  disabled: boolean
  testid: string
  onPick: () => void
}) {
  return (
    <Radio.Card
      name="skill-scope"
      p="sm"
      checked={checked}
      disabled={disabled}
      data-testid={testid}
      onClick={onPick}
    >
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <Radio.Indicator />
        <span className="eva-settings-label">
          <span className="eva-settings-label-title">{title}</span>
          <span className="eva-settings-label-help">{help}</span>
        </span>
      </Group>
    </Radio.Card>
  )
}

/** The Settings tab, in Settings' card and row style: who loads the skill, where it lives, its use. */
export function SkillSettings({ row, detail, assistants, now }: SkillSettingsProps) {
  const profiles = detail?.profiles ?? {}
  const shared = sharedProfiles(assistants, profiles)
  const scope = scopeOf(row.usedBy, assistants, profiles)
  const setScope = (next: SkillScope): void =>
    void setSkillAccess(row.name, scopeAccess(next, assistants, profiles))
  const oneId = scope?.kind === 'one' ? scope.id : (row.usedBy[0] ?? assistants[0]?.id ?? null)
  const oneGroup =
    oneId === null
      ? []
      : assistants
          .filter((a) => accessChange(assistants, profiles, oneId, true)[a.id])
          .map((a) => a.title)
  const usage = detail?.usage
  const lastAt = usage ? usage.lastUsedAt : row.lastUsedAt
  const off = row.usedBy.length === 0

  return (
    <div className="eva-skills-settings" data-testid="skill-settings">
      {row.disabled ? (
        <Text size="sm" c="var(--eva-c-warning)">
          SKILL.md says <code>enabled: false</code>, so no assistant loads it.
        </Text>
      ) : null}

      <Section title="Enabled for">
        <div className="eva-settings-card">
          {assistants.map((a) => (
            <label key={a.id} className="eva-settings-row">
              <Group gap="sm" wrap="nowrap">
                <AgentPortrait id={a.id} className="eva-skills-portrait-lg" />
                <span className="eva-settings-label-title">{a.title}</span>
              </Group>
              <Switch
                size="md"
                aria-label={`Enabled for ${a.title}`}
                data-testid={`skill-enabled-${a.id}`}
                checked={row.usedBy.includes(a.id)}
                disabled={row.disabled}
                onChange={(e) =>
                  void setSkillAccess(
                    row.name,
                    accessChange(assistants, profiles, a.id, e.currentTarget.checked),
                  )
                }
              />
            </label>
          ))}
        </div>
        {shared.map(([profile, titles]) => (
          <Text key={profile} size="sm" c="dimmed">
            {joinTitles(titles)} share the {profile} profile.
          </Text>
        ))}
      </Section>

      <Section title="Scope">
        <SimpleGrid cols={2} spacing="xs">
          <ScopeCard
            title="Global"
            help="Enabled for every assistant"
            checked={scope?.kind === 'global'}
            disabled={row.disabled}
            testid="skill-scope-global"
            onPick={() => setScope({ kind: 'global' })}
          />
          <ScopeCard
            title="One assistant only"
            help={
              oneGroup.length > 0 ? `Only ${joinTitles(oneGroup)} can load it` : 'No assistants'
            }
            checked={scope?.kind === 'one'}
            disabled={row.disabled || oneId === null}
            testid="skill-scope-one"
            onPick={() => {
              if (oneId !== null) setScope({ kind: 'one', id: oneId })
            }}
          />
        </SimpleGrid>
        {scope?.kind === 'one' ? (
          <Select
            size="xs"
            aria-label="Assistant"
            allowDeselect={false}
            data={assistants.map((a) => ({ value: a.id, label: a.title }))}
            value={scope.id}
            onChange={(id) => {
              if (id) setScope({ kind: 'one', id })
            }}
          />
        ) : null}
      </Section>

      <Section title="Source">
        <TextInput
          size="xs"
          readOnly
          aria-label="SKILL.md path"
          value={`${row.source.dir}/SKILL.md`}
          description="Read-only. Edit in the Editor tab."
          inputWrapperOrder={['input', 'description']}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
        />
        {row.also.length > 0 ? (
          <Text size="sm" c="dimmed">
            Also in {row.also.map((s) => `${s.label} (${s.dir})`).join(', ')}
          </Text>
        ) : null}
      </Section>

      <Section title="Files in folder">
        {detail ? (
          <ul className="eva-skills-files">
            {detail.files.map((f) => (
              <li key={f.path}>
                <span className="eva-skills-mono">{f.path}</span>
                <span className="eva-skills-dim">{sizeLabel(f.size)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Text size="sm" c="dimmed">
            Reading the folder
          </Text>
        )}
      </Section>

      <Section title="Last used">
        {lastAt !== null ? (
          <div>
            <Text size="sm">
              {lastUsedLabel(lastAt, now)}
              {usage?.lastUsedBy ? (
                <span className="eva-skills-dim"> by {usage.lastUsedBy}</span>
              ) : null}
            </Text>
            {usage ? (
              <Text size="sm" c="dimmed">
                Loaded {usage.loads30d} {usage.loads30d === 1 ? 'time' : 'times'} in the last 30
                days
              </Text>
            ) : null}
          </div>
        ) : (
          <Text size="sm" c="dimmed">
            Not used in the last 30 days
          </Text>
        )}
      </Section>

      <Section title="Danger zone">
        <div className="eva-settings-card">
          <div className="eva-settings-row eva-settings-row-static">
            <span className="eva-settings-label">
              <span className="eva-settings-label-title">
                {off ? 'Enable skill' : 'Disable skill'}
              </span>
              <span className="eva-settings-label-help">
                {off
                  ? 'Turns it on for every assistant.'
                  : 'Turns it off for every assistant. Files stay on disk.'}
              </span>
            </span>
            <Button
              variant={off ? 'default' : 'light'}
              color={off ? undefined : 'red'}
              disabled={row.disabled}
              data-testid="skill-toggle-all"
              onClick={() =>
                void setSkillAccess(
                  row.name,
                  Object.fromEntries(assistants.map((a) => [a.id, off])),
                )
              }
            >
              {off ? 'Enable skill' : 'Disable skill'}
            </Button>
          </div>
        </div>
      </Section>
    </div>
  )
}
