import { describe, expect, it } from 'vitest'
import { THEME_PRESETS } from '@relay/widget-runtime/theme'
import { canvasThemeMessage } from './theme-message'

describe('canvasThemeMessage', () => {
  it("sends the scheme with that scheme's semantic colors from the preset", () => {
    const forest = THEME_PRESETS.find((p) => p.value === 'forest')!.config
    const dark = canvasThemeMessage(forest, 'dark')
    expect(dark).toMatchObject({
      type: 'relay.theme',
      scheme: 'dark',
      tokens: { body: '#17201a', surface: '#1d2921', text: forest.semantic.dark.text },
    })
    const light = canvasThemeMessage(forest, 'light')
    expect(light.scheme).toBe('light')
    expect(light.tokens.body).toBe('#fbfdfb')
    expect(light.tokens.accent).toBe(forest.primaryPalette[forest.primaryShade.light])
  })
})
