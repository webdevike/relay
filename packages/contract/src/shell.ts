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
  /** Set once the saved configs were read with the focus ring defaulting to off ('auto' = old default). */
  focusRingMigrated: z.boolean().optional(),
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
const ToolKindSchema = z.enum(['browser', 'files', 'terminal'])

export const shellInvoke = {
  'layout.load': {
    input: z.object({}).strict(),
    output: z.object({
      sidebarWidth: z.number(),
      tabs: z.unknown().nullable(),
      /** The saved dockview layout (its toJSON); shell-core reconcileDock reads it. */
      dock: z.unknown().nullable(),
      /** Each workspace's own layout and the pinned tool tabs (shell-core readWorkspaces). */
      workspaces: z.record(z.string(), z.unknown()).nullable(),
      /** The split tree kept before dockview, while no `dock` is saved: migrated once. */
      tiling: z.unknown().nullable(),
      /** The side panel before panes, while neither layout is saved: seeds the first layout. */
      legacyPanel: z.object({ width: z.number(), tool: ToolKindSchema }).nullable(),
      /** The sidebar customization saved in layout.json; the renderer validates it. */
      sidebar: z.record(z.string(), z.unknown()).nullable(),
      reset: z.boolean(),
    }),
  },
  'layout.save': {
    input: z
      .object({
        sidebarWidth: z.number().finite().optional(),
        tabs: SavedTabsSchema.optional(),
        /** The dockview layout (its toJSON); saving it drops the split tree and old panel keys. */
        dock: z.record(z.string(), z.unknown()).optional(),
        /** The workspaces record (shell-core saveWorkspaces), replaced whole. */
        workspaces: z.record(z.string(), z.unknown()).optional(),
        /** The sidebar customization (visibility, order, favorites), replaced whole. */
        sidebar: z.record(z.string(), z.unknown()).optional(),
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
