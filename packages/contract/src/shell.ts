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
    /** Kept across restarts so per-tab state (`draft:<id>` scopes, composer drafts) finds its tab. */
    id: z.number().int().min(0).optional(),
    here: SavedPlaceSchema,
    back: z.array(SavedPlaceSchema).max(50),
    forward: z.array(SavedPlaceSchema).max(50),
    pinned: z.boolean(),
  })
  .passthrough()

export const SavedTabsSchema = z.object({
  active: z.number().int().min(0),
  list: z.array(SavedTabSchema).max(100),
  /** The next new tab's id, so a closed tab's id is never reused after a restart. */
  nextId: z.number().int().min(0).optional(),
})
export type SavedTabs = z.infer<typeof SavedTabsSchema>

// The renderer's Texo-style theme state: the preset config, the preset name it came from, and
// light or dark (kept apart from the preset). The config's shape belongs to the renderer, which
// merges it over the Default preset when loading.
export const SavedThemeSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  preset: z.string().max(200),
  /** Themes Isaac saved: his own, and his versions of built-in presets (same value). */
  themes: z
    .array(
      z.object({
        value: z.string().min(1).max(200),
        label: z.string().min(1).max(80),
        config: z.record(z.string(), z.unknown()),
      }),
    )
    .max(200)
    .optional(),
  colorScheme: z.enum(['light', 'dark']).optional(),
})
export type SavedTheme = z.infer<typeof SavedThemeSchema>

export const ChatSettingsSchema = z.object({
  show_thinking: z.boolean(),
  show_tools: z.boolean(),
  harness: z.enum(['omp', 'claude']),
  favorite_models: z.array(z.string().min(1).max(400)).max(500),
})
export type ChatSettings = z.infer<typeof ChatSettingsSchema>

const Empty = z.object({})
const PanelToolSchema = z.enum(['browser', 'files', 'artifacts'])

export const shellInvoke = {
  'layout.load': {
    input: z.object({}).strict(),
    output: z.object({
      sidebarWidth: z.number(),
      panelWidth: z.number(),
      tabs: z.unknown().nullable(),
      /** Isaac's explicit panel open/close per browser scope, oldest first. */
      panelChoices: z.record(z.string(), z.boolean()),
      panelTool: PanelToolSchema,
      reset: z.boolean(),
    }),
  },
  'layout.save': {
    input: z
      .object({
        sidebarWidth: z.number().finite().optional(),
        panelWidth: z.number().finite().optional(),
        tabs: SavedTabsSchema.optional(),
        /** Upserts per scope; null forgets the scope (a draft chat renamed to its session). */
        panelChoices: z
          .record(z.string().max(4096), z.boolean().nullable())
          .refine((o) => Object.keys(o).length <= 200, 'too many scopes')
          .optional(),
        panelTool: PanelToolSchema.optional(),
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
