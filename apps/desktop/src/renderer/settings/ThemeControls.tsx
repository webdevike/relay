import type { ReactNode } from 'react'
import {
  Accordion,
  ColorInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  type MantineColorShade,
} from '@mantine/core'
import { CodeHighlight } from '@mantine/code-highlight'
import {
  SIZE_KEYS,
  cssVariablesFor,
  themeOverrideFor,
  useThemeConfig,
  type ColorScheme,
  type SemanticColors,
  type ThemeConfig,
  type ThemeSize,
} from '../theme/theme-config'

// Texo's theme inspector (src/app/theme-controls.tsx), on plain Mantine components.

export type ThemeControlsTab = 'colors' | 'typography' | 'other' | 'generate'

const colorOptions = [
  'blue',
  'cyan',
  'grape',
  'green',
  'indigo',
  'lime',
  'orange',
  'pink',
  'red',
  'teal',
  'violet',
  'yellow',
]

const fontOptions = [
  {
    label: 'System sans',
    value: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Monospace', value: 'ui-monospace, monospace' },
]

const shadeOptions = Array.from({ length: 10 }, (_, value) => String(value))

const categoryStyles = {
  chevron: { marginInlineEnd: 4, minWidth: 12, width: 12 },
  control: {
    background: 'var(--eva-color-muted)',
    border: '1px solid var(--mantine-color-default-border)',
    borderRadius: 'var(--mantine-radius-sm)',
    color: 'var(--mantine-color-text)',
    fontSize: 11,
    fontWeight: 600,
    minHeight: 26,
    padding: '2px 8px',
    width: 'fit-content',
  },
  label: { lineHeight: 1, padding: 0 },
  panel: { paddingBottom: 10 },
}

function ScaleEditor({
  label,
  onChange,
  values,
}: {
  label: string
  onChange: (size: ThemeSize, value: string) => void
  values: Record<ThemeSize, string>
}) {
  return (
    <Stack gap="xs">
      <Text fw={500} size="sm">
        {label}
      </Text>
      {SIZE_KEYS.map((size) => (
        <TextInput
          key={size}
          label={size}
          value={values[size]}
          onChange={(event) => onChange(size, event.target.value)}
        />
      ))}
    </Stack>
  )
}

function updateScale(
  config: ThemeConfig,
  key: 'fontSizes' | 'lineHeights' | 'radius' | 'shadows' | 'spacing',
  size: ThemeSize,
  value: string,
): ThemeConfig {
  return { ...config, [key]: { ...config[key], [size]: value } }
}

function ControlCategory({
  children,
  label,
  value,
}: {
  children: ReactNode
  label: string
  value: string
}) {
  return (
    <Accordion variant="unstyled" styles={{ ...categoryStyles, item: { border: 0 } }}>
      <Accordion.Item value={value}>
        <Accordion.Control>{label}</Accordion.Control>
        <Accordion.Panel>{children}</Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  )
}

const semanticCategories: { label: string; value: string; keys: (keyof SemanticColors)[] }[] = [
  { label: 'CARD', value: 'card', keys: ['card'] },
  { label: 'POPOVER', value: 'popover', keys: ['popover'] },
  { label: 'MUTED', value: 'muted', keys: ['muted', 'dimmed'] },
  { label: 'BORDER & INPUT', value: 'border-input', keys: ['border', 'input', 'placeholder'] },
  { label: 'SIDEBAR', value: 'sidebar', keys: ['body', 'surface'] },
  { label: 'TEXT', value: 'text', keys: ['text'] },
]

function SemanticCategories() {
  const { config, updateConfig } = useThemeConfig()

  const updateColor = (scheme: ColorScheme, key: keyof SemanticColors, value: string) => {
    updateConfig((current) => ({
      ...current,
      semantic: { ...current.semantic, [scheme]: { ...current.semantic[scheme], [key]: value } },
    }))
  }

  return (
    <Accordion
      multiple
      variant="unstyled"
      styles={{ ...categoryStyles, item: { border: 0, marginBottom: 'var(--mantine-spacing-xs)' } }}
    >
      {semanticCategories.map((category) => (
        <Accordion.Item key={category.value} value={category.value}>
          <Accordion.Control>{category.label}</Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              {(['light', 'dark'] as const).flatMap((scheme) =>
                category.keys.map((key) => (
                  <ColorInput
                    key={`${scheme}-${key}`}
                    label={`${scheme === 'light' ? 'Light' : 'Dark'} ${key}`}
                    value={config.semantic[scheme][key]}
                    onChange={(value) => updateColor(scheme, key, value)}
                  />
                )),
              )}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      ))}
    </Accordion>
  )
}

function ColorsControls() {
  const { config, updateConfig } = useThemeConfig()

  return (
    <Stack gap="xs">
      <ControlCategory label="PRIMARY" value="primary">
        <Stack gap="xs">
          <Select
            data={colorOptions}
            label="Primary color"
            value={config.primaryColor}
            onChange={(value) =>
              value && updateConfig((current) => ({ ...current, primaryColor: value }))
            }
          />
          {config.primaryPalette.map((color, index) => (
            <ColorInput
              key={index}
              label={`Shade ${index}`}
              value={color}
              onChange={(value) =>
                updateConfig((current) => {
                  const primaryPalette = [...current.primaryPalette]
                  primaryPalette[index] = value
                  return {
                    ...current,
                    primaryPalette: primaryPalette as unknown as ThemeConfig['primaryPalette'],
                  }
                })
              }
            />
          ))}
          <Select
            data={shadeOptions}
            label="Primary shade, light"
            value={String(config.primaryShade.light)}
            onChange={(value) =>
              value &&
              updateConfig((current) => ({
                ...current,
                primaryShade: {
                  ...current.primaryShade,
                  light: Number(value) as MantineColorShade,
                },
              }))
            }
          />
          <Select
            data={shadeOptions}
            label="Primary shade, dark"
            value={String(config.primaryShade.dark)}
            onChange={(value) =>
              value &&
              updateConfig((current) => ({
                ...current,
                primaryShade: { ...current.primaryShade, dark: Number(value) as MantineColorShade },
              }))
            }
          />
        </Stack>
      </ControlCategory>

      <ControlCategory label="CHART" value="chart">
        <Stack gap="xs">
          {config.chartColors.map((color, index) => (
            <ColorInput
              key={index}
              label={`Chart ${index + 1}`}
              value={color}
              onChange={(value) =>
                updateConfig((current) => {
                  const chartColors = [...current.chartColors] as ThemeConfig['chartColors']
                  chartColors[index] = value
                  return { ...current, chartColors }
                })
              }
            />
          ))}
        </Stack>
      </ControlCategory>

      <ControlCategory label="CONTRAST" value="contrast">
        <Stack gap="xs">
          <Switch
            checked={config.autoContrast}
            label="Automatic contrast"
            onChange={(event) => {
              const autoContrast = event.target.checked
              updateConfig((current) => ({ ...current, autoContrast }))
            }}
          />
          <TextInput
            label="Luminance threshold"
            type="number"
            value={config.luminanceThreshold}
            onChange={(event) => {
              const luminanceThreshold = Number(event.target.value)
              updateConfig((current) => ({ ...current, luminanceThreshold }))
            }}
          />
        </Stack>
      </ControlCategory>

      <SemanticCategories />
    </Stack>
  )
}

function TypographyControls() {
  const { config, updateConfig } = useThemeConfig()

  return (
    <Stack gap="xs">
      <ControlCategory label="FONT FAMILY" value="font-family">
        <Stack gap="xs">
          <Select
            data={fontOptions}
            label="Body font"
            searchable
            value={config.fontFamily}
            onChange={(value) =>
              value && updateConfig((current) => ({ ...current, fontFamily: value }))
            }
          />
          <Select
            data={fontOptions}
            label="Heading font"
            searchable
            value={config.fontFamilyHeadings}
            onChange={(value) =>
              value && updateConfig((current) => ({ ...current, fontFamilyHeadings: value }))
            }
          />
          <TextInput
            label="Monospace font"
            value={config.fontFamilyMonospace}
            onChange={(event) => {
              const fontFamilyMonospace = event.target.value
              updateConfig((current) => ({ ...current, fontFamilyMonospace }))
            }}
          />
        </Stack>
      </ControlCategory>

      <ControlCategory label="FONT SIZES" value="font-sizes">
        <ScaleEditor
          label="Font sizes"
          values={config.fontSizes}
          onChange={(size, value) =>
            updateConfig((current) => updateScale(current, 'fontSizes', size, value))
          }
        />
      </ControlCategory>

      <ControlCategory label="LINE HEIGHT" value="line-height">
        <ScaleEditor
          label="Line heights"
          values={config.lineHeights}
          onChange={(size, value) =>
            updateConfig((current) => updateScale(current, 'lineHeights', size, value))
          }
        />
      </ControlCategory>

      <ControlCategory label="RENDERING" value="rendering">
        <Switch
          checked={config.fontSmoothing}
          label="Font smoothing"
          onChange={(event) => {
            const fontSmoothing = event.target.checked
            updateConfig((current) => ({ ...current, fontSmoothing }))
          }}
        />
      </ControlCategory>
    </Stack>
  )
}

function OtherControls() {
  const { config, updateConfig } = useThemeConfig()

  return (
    <Stack gap="xs">
      <ControlCategory label="BORDER RADIUS" value="radius">
        <Stack gap="xs">
          <Select
            data={[...SIZE_KEYS]}
            label="Default radius"
            value={config.defaultRadius}
            onChange={(value) =>
              value &&
              updateConfig((current) => ({ ...current, defaultRadius: value as ThemeSize }))
            }
          />
          <ScaleEditor
            label="Radius scale"
            values={config.radius}
            onChange={(size, value) =>
              updateConfig((current) => updateScale(current, 'radius', size, value))
            }
          />
        </Stack>
      </ControlCategory>

      <ControlCategory label="SPACING" value="spacing">
        <ScaleEditor
          label="Spacing scale"
          values={config.spacing}
          onChange={(size, value) =>
            updateConfig((current) => updateScale(current, 'spacing', size, value))
          }
        />
      </ControlCategory>

      <ControlCategory label="SHADOWS" value="shadows">
        <Stack gap="xs">
          <ScaleEditor
            label="Shadow scale"
            values={config.shadows}
            onChange={(size, value) =>
              updateConfig((current) => updateScale(current, 'shadows', size, value))
            }
          />
          <TextInput
            label="Card box shadow"
            value={config.effects.cardShadow}
            onChange={(event) => {
              const cardShadow = event.target.value
              updateConfig((current) => ({
                ...current,
                effects: { ...current.effects, cardShadow },
              }))
            }}
          />
          <TextInput
            label="Control box shadow"
            value={config.effects.controlShadow}
            onChange={(event) => {
              const controlShadow = event.target.value
              updateConfig((current) => ({
                ...current,
                effects: { ...current.effects, controlShadow },
              }))
            }}
          />
        </Stack>
      </ControlCategory>

      <ControlCategory label="BEHAVIOR" value="behavior">
        <Stack gap="xs">
          <TextInput
            label="Scale"
            type="number"
            value={config.scale}
            onChange={(event) => {
              const scale = Number(event.target.value)
              updateConfig((current) => ({ ...current, scale }))
            }}
          />
          <Select
            data={['auto', 'always', 'never']}
            label="Focus ring"
            value={config.focusRing}
            onChange={(value) =>
              value &&
              updateConfig((current) => ({
                ...current,
                focusRing: value as ThemeConfig['focusRing'],
              }))
            }
          />
          <Select
            data={['default', 'pointer']}
            label="Interactive cursor"
            value={config.cursorType}
            onChange={(value) =>
              value &&
              updateConfig((current) => ({
                ...current,
                cursorType: value as ThemeConfig['cursorType'],
              }))
            }
          />
          <Switch
            checked={config.respectReducedMotion}
            label="Respect reduced motion"
            onChange={(event) => {
              const respectReducedMotion = event.target.checked
              updateConfig((current) => ({ ...current, respectReducedMotion }))
            }}
          />
        </Stack>
      </ControlCategory>
    </Stack>
  )
}

function GenerateControls() {
  const { config } = useThemeConfig()
  // The same override and resolver the app runs, minus the class hooks a copy can't carry.
  const { components: _components, ...theme } = themeOverrideFor(config)
  const code = `export const theme = createTheme(${JSON.stringify(theme, null, 2)});

export const cssVariablesResolver = () => (${JSON.stringify(cssVariablesFor(config), null, 2)});`

  return <CodeHighlight code={code} language="tsx" />
}

export function ThemeControls({ tab }: { tab: ThemeControlsTab }) {
  return (
    <Stack className="eva-theme-properties" data-testid="theme-properties">
      {tab === 'colors' && <ColorsControls />}
      {tab === 'typography' && <TypographyControls />}
      {tab === 'other' && <OtherControls />}
      {tab === 'generate' && <GenerateControls />}
    </Stack>
  )
}
