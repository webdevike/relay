import { ActionIcon, Tabs } from '@mantine/core'
import { IconSparkles, IconX } from '@tabler/icons-react'
import type { SkillAssistant, SkillDetail, SkillRow } from '@evaos/contract'
import { SkillEditor } from './SkillEditor'
import { SkillSettings } from './SkillSettings'

interface SkillPanelProps {
  row: SkillRow
  detail: SkillDetail | null
  assistants: readonly SkillAssistant[]
  now: number
  onClose: () => void
}

/** The detail panel beside the table: the skill's header, then its Editor and Settings tabs. */
export function SkillPanel({ row, detail, assistants, now, onClose }: SkillPanelProps) {
  return (
    <aside className="eva-skills-panel" aria-label={row.name} data-testid="skill-panel">
      <header className="eva-skills-panel-head">
        <h2 className="eva-skills-panel-title">
          <IconSparkles size={16} stroke={1.5} aria-hidden />
          <span className="eva-skills-panel-name">{row.name}</span>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label="Close"
            data-testid="skill-panel-close"
            onClick={onClose}
          >
            <IconX size={16} />
          </ActionIcon>
        </h2>
        <div className="eva-skills-mono eva-skills-dim">{row.source.dir}</div>
        <div className="eva-skills-desc-full">{row.description}</div>
      </header>
      <Tabs defaultValue="editor" keepMounted className="eva-skills-tabs">
        <Tabs.List>
          <Tabs.Tab value="editor">Editor</Tabs.Tab>
          <Tabs.Tab value="settings">Settings</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="editor" className="eva-skills-tabpanel">
          <SkillEditor key={row.name} name={row.name} />
        </Tabs.Panel>
        <Tabs.Panel value="settings" className="eva-skills-tabpanel eva-skills-tabpanel-scroll">
          <SkillSettings row={row} detail={detail} assistants={assistants} now={now} />
        </Tabs.Panel>
      </Tabs>
    </aside>
  )
}
