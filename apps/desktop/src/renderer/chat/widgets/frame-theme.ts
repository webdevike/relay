import { DEFAULT_THEME } from '@mantine/core'
import type { FrameTheme } from '@relay/widget-runtime/frame'
import type { ColorScheme, ThemeConfig } from '@relay/widget-runtime/theme'

export type FrameRuntime = 'html' | 'mantine'

/** A theme size (`0.875rem`, `12px`, `0`) in CSS pixels, as Mantine scales it. */
function px(value: string, scale: number): number {
  const n = Number.parseFloat(value)
  if (!Number.isFinite(n)) return 0
  return Math.round((value.trim().endsWith('rem') ? n * 16 : n) * scale * 100) / 100
}

/**
 * The palette and type a widget page draws with, from the Settings > Theme config in light or
 * dark: text roles from the semantic colors, the accent and status colors at the scheme's primary
 * shade (as Mantine's filled variant picks them), the chat's body size, and the radii.
 */
export function frameThemeFor(config: ThemeConfig, scheme: ColorScheme): FrameTheme {
  const colors = config.semantic[scheme]
  const shade = config.primaryShade[scheme]
  const size = px(config.fontSizes.sm, config.scale)
  return {
    dark: scheme === 'dark',
    colors: {
      fg: colors.text,
      muted: colors.dimmed,
      faint: colors.placeholder,
      border: colors.border,
      surface: colors.surface,
      raised: colors.card,
      accent: config.primaryPalette[shade],
      ok: DEFAULT_THEME.colors.green[shade],
      warn: DEFAULT_THEME.colors.yellow[shade],
      danger: DEFAULT_THEME.colors.red[shade],
      bg: 'transparent',
    },
    font: {
      family: config.fontFamily,
      mono: config.fontFamilyMonospace,
      size,
      lineHeight: Math.round(size * Number.parseFloat(config.lineHeights.sm)),
    },
    radius: {
      sm: px(config.radius.sm, config.scale),
      md: px(config.radius.md, config.scale),
      lg: px(config.radius.lg, config.scale),
    },
  }
}

/**
 * The `relay-widget:` page main serves for one widget (main/chat/widget-frame.ts): the agent's
 * code, the palette and, for Mantine, the theme config it draws with, and `fill` for a page that
 * fills a fixed-size box (a dashboard tile with a height) instead of sizing to its content.
 */
export function frameUrl(
  runtime: FrameRuntime,
  source: string,
  theme: FrameTheme,
  config?: ThemeConfig,
  fill = false,
): string {
  const params = new URLSearchParams({ source, theme: JSON.stringify(theme) })
  if (config) params.set('config', JSON.stringify(config))
  if (fill) params.set('fill', '1')
  return `relay-widget://frame/${runtime}?${params.toString()}`
}

/** The `relay-widget:` page of a canvas prototype: its JSX in its design system, light or dark. */
export function protoFrameUrl(source: string, system: string, scheme: ColorScheme): string {
  return `relay-widget://frame/proto?${new URLSearchParams({ source, system, scheme }).toString()}`
}
