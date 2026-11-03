import type { ColorScheme, ThemeConfig } from '@relay/widget-runtime/theme'

/**
 * What the live canvas page needs to look like this window: the scheme and the semantic colors of
 * the current theme preset (so a Forest dark board is Forest's #17201a, not a generic dark).
 * The page (`packages/canvas-web/src/theme.ts`) takes it as `relay.theme` through postMessage.
 */
export function canvasThemeMessage(config: ThemeConfig, scheme: ColorScheme) {
  const colors = config.semantic[scheme]
  const accent = config.primaryPalette[config.primaryShade[scheme]]
  return {
    type: 'relay.theme' as const,
    scheme,
    tokens: {
      body: colors.body,
      text: colors.text,
      dimmed: colors.dimmed,
      border: colors.border,
      popover: colors.popover,
      surface: colors.surface,
      ...(accent ? { accent } : {}),
    },
  }
}
