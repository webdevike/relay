import { z } from 'zod'

export const SavedPlaceSchema = z
  .object({
    page: z.string().max(200),
    chat: z.string().nullable().optional(),
    settings_section: z.string().optional(),
    meeting: z.string().nullable().optional(),
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

export const AppearanceSchema = z.enum(['light', 'dark', 'system'])
export type Appearance = z.infer<typeof AppearanceSchema>

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
    output: z.object({ appearance: AppearanceSchema }),
  },
  'theme.setAppearance': {
    input: z.object({ appearance: AppearanceSchema }).strict(),
    output: Empty,
  },
  'settings.load': { input: z.object({}).strict(), output: ChatSettingsSchema },
  'settings.save': { input: ChatSettingsSchema.partial().strict(), output: ChatSettingsSchema },
} as const
