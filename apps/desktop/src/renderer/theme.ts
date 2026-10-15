import { createTheme, type MantineColorsTuple } from '@mantine/core'

const eva: MantineColorsTuple = [
  '#eef0ff',
  '#dde1ff',
  '#bcc4ff',
  '#99a5ff',
  '#7c8cff',
  '#6677f5',
  '#5565e0',
  '#4553c0',
  '#37439c',
  '#2a347a',
]

export const theme = createTheme({
  primaryColor: 'eva',
  colors: { eva },
  spacing: { xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '32px' },
  fontSizes: { xs: '12px', sm: '12px', md: '14px', lg: '16px', xl: '20px' },
  fontFamilyMonospace: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
})
