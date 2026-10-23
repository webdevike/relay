import { z } from 'zod'

export const SavedPlaceSchema = z
  .object({
    page: z.string().max(200),
    chat: z.string().nullable().optional(),
    settings_section: z.string().optional(),
    meeting: z.string().nullable().optional(),
    canvas: z.string().nullable().optional(),
  })
  .passthrough()

export const SavedTabSchema = z
  .object({
    here: SavedPlaceSchema,
    back: z.array(SavedPlaceSchema).max(50),
    forward: z.array(SavedPlaceSchema).max(50),
    pinned: z.boolean(),
  })
  .passthrough()

export const SavedTabsSchema = z.object({
  active: z.number().int().min(0),
  list: z.array(SavedTabSchema).max(100),
})
export type SavedTabs = z.infer<typeof SavedTabsSchema>

// The renderer's Texo-style theme state: the preset config, the preset name it came from, and
// light or dark (kept apart from the preset). The config's shape belongs to the renderer, which
// merges it over the Default preset when loading.
export const SavedThemeSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  preset: z.string().max(200),
  colorScheme: z.enum(['light', 'dark']).optional(),
})
export type SavedTheme = z.infer<typeof SavedThemeSchema>

export const ChatSettingsSchema = z.object({
  show_thinking: z.boolean(),
  show_tools: z.boolean(),
  harness: z.enum(['omp', 'claude']),
})
export type ChatSettings = z.infer<typeof ChatSettingsSchema>

const Empty = z.object({})

export const shellInvoke = {
  'layout.load': {
    input: z.object({}).strict(),
    output: z.object({
      sidebarWidth: z.number(),
      panelWidth: z.number(),
      tabs: z.unknown().nullable(),
      reset: z.boolean(),
    }),
  },
  'layout.save': {
    input: z
      .object({
        sidebarWidth: z.number().finite().optional(),
        panelWidth: z.number().finite().optional(),
        tabs: SavedTabsSchema.optional(),
      })
      .strict(),
    output: Empty,
  },
  'theme.load': {
    input: z.object({}).strict(),
    output: z.object({ theme: SavedThemeSchema.nullable() }),
  },
  'theme.save': {
    input: SavedThemeSchema.strict(),
    output: Empty,
  },
  'settings.load': { input: z.object({}).strict(), output: ChatSettingsSchema },
  'settings.save': { input: ChatSettingsSchema.partial().strict(), output: ChatSettingsSchema },
} as const
