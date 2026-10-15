import {
  ActionIcon,
  Button,
  Input,
  NumberInput,
  Select,
  Textarea,
  TextInput,
  createTheme,
  type MantineColorsTuple,
} from '@mantine/core'

// Mantine requires a ten-step primary entry. Actual variants resolve directly to the live
// native tokens below, so no second palette competes with the theme editor.
const colorScale = (key: string): MantineColorsTuple => {
  const color = `var(--eva-c-${key})`
  return [color, color, color, color, color, color, color, color, color, color]
}
const controlHeight = (size: string | undefined): string => {
  switch (size ?? 'md') {
    case 'xs': return 'var(--eva-kit-control-xs)'
    case 'sm': return 'var(--eva-kit-control-sm)'
    case 'md': return 'var(--eva-kit-control-md)'
    case 'lg': return 'var(--eva-kit-control-lg)'
    case 'xl': return 'var(--eva-control-lg)'
    default: return size ?? 'var(--eva-kit-control-md)'
  }
}

export const theme = createTheme({
  primaryColor: 'eva',
  colors: {
    eva: colorScale('primary-background'),
    red: colorScale('danger-background'),
    green: colorScale('success-background'),
    yellow: colorScale('warning-background'),
    orange: colorScale('warning-background'),
    blue: colorScale('info-background'),
    gray: colorScale('muted-foreground'),
    dark: colorScale('muted-background'),
  },
  spacing: { xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '32px' },
  fontSizes: {
    xs: 'var(--eva-fz-label)', sm: 'var(--eva-fz-body)', md: 'var(--eva-fz-body)',
    lg: 'var(--eva-fz-heading)', xl: 'var(--eva-fz-display)',
  },
  lineHeights: { xs: '1.4', sm: '1.45', md: '1.45', lg: '1.55', xl: '1.65' },
  fontFamily: 'var(--eva-font-ui)',
  fontFamilyMonospace: 'var(--eva-font-code)',
  defaultRadius: 'var(--eva-radius)',
  variantColorResolver: ({ color, variant }) => {
    const family = color === 'red' ? 'danger' : color === 'green' ? 'success'
      : color === 'yellow' || color === 'orange' ? 'warning' : color === 'blue' ? 'info'
        : color === 'gray' || color === 'dark' ? 'secondary' : 'primary'
    const token = (name: string): string => `var(--eva-c-${name})`
    if (variant === 'default') return {
      background: token('button-background'), hover: token('button-hover-background'),
      color: token('button-foreground'), border: `1px solid ${token('border')}`,
    }
    if (variant === 'subtle' || variant === 'transparent') return {
      background: 'transparent', hover: variant === 'transparent' ? 'transparent' : token('accent-background'),
      color: token(family === 'primary' || family === 'secondary' ? 'muted-foreground' : `${family}-background`),
      border: '1px solid transparent',
    }
    if (variant === 'outline' || variant === 'light') return {
      background: variant === 'light' ? token('accent-background') : 'transparent',
      hover: token('accent-background'), color: token(`${family}-background`),
      border: variant === 'outline' ? `1px solid ${token(`${family}-background`)}` : '1px solid transparent',
    }
    return {
      background: token(`button-${family}-background`), hover: token(`button-${family}-hover-background`),
      color: token(`button-${family}-foreground`), border: '1px solid transparent',
    }
  },
  components: {
    Button: Button.extend({
      defaultProps: { size: 'md' },
      classNames: { root: 'eva-control-button' },
      vars: (_theme, props) => ({ root: {
        '--button-height': controlHeight(props.size?.startsWith('compact-') ? 'sm' : props.size),
        '--button-fz': 'var(--eva-fz-body)',
        '--button-padding-x': 'var(--eva-space-native-xs)',
      } }),
    }),
    ActionIcon: ActionIcon.extend({
      defaultProps: { size: 'var(--eva-tile-md)' },
      classNames: { root: 'eva-control-icon' },
    }),
    Input: Input.extend({
      classNames: { input: 'eva-control-input', section: 'eva-control-input-section' },
      vars: (_theme, props) => ({ wrapper: {
        '--input-height': controlHeight(props.size),
        '--input-fz': 'var(--eva-fz-body)',
      } }),
    }),
    InputWrapper: Input.Wrapper.extend({ classNames: {
      label: 'eva-control-label', description: 'eva-control-description', error: 'eva-control-error',
    } }),
    TextInput: TextInput.extend({ defaultProps: { size: 'md' } }),
    NumberInput: NumberInput.extend({ defaultProps: { size: 'md' } }),
    Select: Select.extend({ defaultProps: { size: 'md' } }),
    Textarea: Textarea.extend({ defaultProps: { size: 'md' } }),
  },
})
