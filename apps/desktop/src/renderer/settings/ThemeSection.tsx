import { useState, type ReactNode } from 'react'
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Progress,
  Radio,
  SegmentedControl,
  Select,
  Slider,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core'
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconChevronDown,
  IconInfoCircle,
  IconMoon,
  IconSun,
} from '@tabler/icons-react'
import { ScrollArea } from '../ui/ScrollArea'
import { EvaMenu } from '../overlay/EvaMenu'
import {
  THEME_PRESETS,
  setColorScheme,
  useColorScheme,
  useThemeConfig,
} from '../theme/theme-config'
import { ThemeControls, type ThemeControlsTab } from './ThemeControls'
import { ThemePicker } from './ThemePicker'

// Texo's /theme route: a 300px tool column (preset picker, inspector tabs, controls) beside
// a preview of real components.

const compactPillTabs = {
  tab: {
    borderRadius: 'var(--mantine-radius-xl)',
    fontSize: 'var(--mantine-font-size-xs)',
    padding: '4px 10px',
    whiteSpace: 'nowrap' as const,
  },
}

export function ThemeSection() {
  const [tab, setTab] = useState<ThemeControlsTab>('colors')
  const { applyPreset, canRedo, canUndo, config, preset, redo, undo } = useThemeConfig()
  const scheme = useColorScheme()
  const options = [
    ...(preset === 'custom' ? [{ config, label: 'Custom', value: 'custom' }] : []),
    ...THEME_PRESETS,
  ]

  return (
    <div className="eva-theme-split" data-testid="theme-editor">
      <aside className="eva-theme-tools" aria-label="Theme properties">
        <Group className="eva-theme-picker-row" gap="xs" wrap="nowrap">
          <div className="eva-theme-picker">
            <ThemePicker
              onChange={(value) => value !== 'custom' && applyPreset(value)}
              options={options}
              value={preset}
            />
          </div>
          <ActionIcon
            aria-label="Toggle color scheme"
            data-testid="theme-color-scheme"
            data-scheme={scheme}
            variant="subtle"
            onClick={() => setColorScheme(scheme === 'light' ? 'dark' : 'light')}
          >
            {scheme === 'light' ? <IconSun size={16} /> : <IconMoon size={16} />}
          </ActionIcon>
          <ActionIcon aria-label="Undo theme" disabled={!canUndo} variant="subtle" onClick={undo}>
            <IconArrowBackUp size={16} />
          </ActionIcon>
          <ActionIcon aria-label="Redo theme" disabled={!canRedo} variant="subtle" onClick={redo}>
            <IconArrowForwardUp size={16} />
          </ActionIcon>
        </Group>
        <Tabs
          value={tab}
          onChange={(value) => value && setTab(value as ThemeControlsTab)}
          styles={compactPillTabs}
          variant="pills"
        >
          <Tabs.List>
            <Tabs.Tab value="colors">Colors</Tabs.Tab>
            <Tabs.Tab value="typography">Typography</Tabs.Tab>
            <Tabs.Tab value="other">Other</Tabs.Tab>
            <Tabs.Tab value="generate">Generate</Tabs.Tab>
          </Tabs.List>
        </Tabs>
        <ScrollArea className="eva-theme-controls-scroll" scrollKey="theme-controls">
          <ThemeControls tab={tab} />
        </ScrollArea>
      </aside>
      <ScrollArea
        className="eva-theme-content"
        scrollKey="theme-preview"
        data-testid="theme-preview"
      >
        <ThemePreview />
      </ScrollArea>
    </div>
  )
}

function PreviewSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack gap="xs">
      <Title order={2}>{title}</Title>
      {children}
    </Stack>
  )
}

function ThemePreview() {
  const [checked, setChecked] = useState(true)
  const [switched, setSwitched] = useState(true)
  const [radio, setRadio] = useState('day')
  const [slider, setSlider] = useState(40)
  const [period, setPeriod] = useState('week')
  const [menuOpened, setMenuOpened] = useState(false)

  return (
    <Stack gap="xl" p="lg">
      <PreviewSection title="Buttons">
        <Group gap="xs">
          <Button>Primary</Button>
          <Button variant="default">Default</Button>
          <Button variant="light">Light</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="subtle">Subtle</Button>
          <Button color="red">Danger</Button>
          <Button disabled>Disabled</Button>
        </Group>
      </PreviewSection>
      <PreviewSection title="Inputs">
        <Group grow align="flex-start">
          <TextInput label="Name" placeholder="Type to preview" />
          <Select label="Status" placeholder="Pick one" data={['Open', 'In progress', 'Done']} />
        </Group>
        <Group gap="lg">
          <Switch
            label="Switch"
            checked={switched}
            onChange={(event) => setSwitched(event.currentTarget.checked)}
          />
          <Checkbox
            label="Checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.currentTarget.checked)}
          />
          <Radio.Group value={radio} onChange={setRadio}>
            <Group gap="md">
              <Radio label="Day" value="day" />
              <Radio label="Week" value="week" />
            </Group>
          </Radio.Group>
        </Group>
        <Slider aria-label="Preview slider" value={slider} onChange={setSlider} />
        <Progress value={64} />
      </PreviewSection>
      <PreviewSection title="Navigation">
        <SegmentedControl
          value={period}
          onChange={setPeriod}
          data={[
            { label: 'Day', value: 'day' },
            { label: 'Week', value: 'week' },
            { label: 'Month', value: 'month' },
          ]}
        />
        <Tabs defaultValue="overview">
          <Tabs.List>
            <Tabs.Tab value="overview">Overview</Tabs.Tab>
            <Tabs.Tab value="activity">Activity</Tabs.Tab>
            <Tabs.Tab value="settings">Settings</Tabs.Tab>
          </Tabs.List>
        </Tabs>
        <Group gap="xs">
          <EvaMenu opened={menuOpened} onChange={setMenuOpened} position="bottom-start">
            <EvaMenu.Target>
              <Button variant="default" rightSection={<IconChevronDown size={14} />}>
                Open menu
              </Button>
            </EvaMenu.Target>
            <EvaMenu.Dropdown>
              <EvaMenu.Item>Rename</EvaMenu.Item>
              <EvaMenu.Item>Duplicate</EvaMenu.Item>
              <EvaMenu.Divider />
              <EvaMenu.Item color="red">Delete</EvaMenu.Item>
            </EvaMenu.Dropdown>
          </EvaMenu>
          <Badge>Badge</Badge>
          <Badge variant="light">Light</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge color="gray">Gray</Badge>
        </Group>
      </PreviewSection>
      <PreviewSection title="Cards and alerts">
        <Card withBorder padding="lg">
          <Text fw={600}>Weekly note</Text>
          <Text size="sm" c="dimmed">
            Cards use the card color and card shadow from the theme.
          </Text>
        </Card>
        <Alert icon={<IconInfoCircle size={16} />} title="Info">
          The theme saves as you edit.
        </Alert>
        <Alert color="yellow" icon={<IconAlertTriangle size={16} />} title="Warning">
          Low contrast is easy to miss.
        </Alert>
      </PreviewSection>
      <PreviewSection title="Table">
        <Table withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Job</Table.Th>
              <Table.Th ta="center">Status</Table.Th>
              <Table.Th ta="right">Runs</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {[
              ['Morning brief', 'Done', 12],
              ['Slack sync', 'Running', 48],
              ['Backup', 'Queued', 3],
            ].map(([job, status, runs]) => (
              <Table.Tr key={String(job)}>
                <Table.Td>{job}</Table.Td>
                <Table.Td ta="center">{status}</Table.Td>
                <Table.Td ta="right">{runs}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </PreviewSection>
      <PreviewSection title="Chart colors">
        <div
          className="eva-theme-chart"
          role="img"
          aria-label="Ten bars using the five theme chart colors"
        >
          {[44, 72, 58, 90, 36, 64, 80, 50, 68, 40].map((height, index) => (
            <div
              key={index}
              style={{ height, background: `var(--eva-chart-${(index % 5) + 1})` }}
            />
          ))}
        </div>
      </PreviewSection>
    </Stack>
  )
}
