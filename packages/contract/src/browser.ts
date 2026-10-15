import { z } from 'zod'

export const TabIdSchema = z.string().regex(/^t[0-9]{1,6}$/)

export const TabStateSchema = z.object({
  id: TabIdSchema,
  url: z.string(),
  title: z.string(),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  blank: z.boolean(),
  error: z.object({ host: z.string(), code: z.number() }).nullable(),
  favicon: z.string().nullable(),
})
export type TabState = z.output<typeof TabStateSchema>

export const TabsSnapshotSchema = z.object({ tabs: z.array(TabStateSchema), activeId: z.string() })
export type TabsSnapshot = z.output<typeof TabsSnapshotSchema>

const tabOnly = z.object({ tabId: TabIdSchema }).strict()
const okOut = z.object({ ok: z.literal(true) })

// Browser channels. Plans 01-08 and 01-09 extend these maps.
export const browserInvoke = {
  'browser.state': { input: z.object({}).strict(), output: TabsSnapshotSchema },
  'browser.navigate': {
    input: z.object({ tabId: TabIdSchema, input: z.string().max(2048) }).strict(),
    output: z.object({ url: z.string().nullable() }),
  },
  'browser.back': { input: tabOnly, output: okOut },
  'browser.forward': { input: tabOnly, output: okOut },
  'browser.reload': { input: tabOnly, output: okOut },
  'browser.stop': { input: tabOnly, output: okOut },
  'browser.copyLink': { input: tabOnly, output: okOut },
  'browser.openExternal': { input: tabOnly, output: okOut },
  'browser.setSlot': {
    input: z
      .object({
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        width: z.number().int().min(0),
        height: z.number().int().min(0),
      })
      .strict(),
    output: okOut,
  },
  'browser.setOccluded': {
    input: z.object({ occluded: z.boolean() }).strict(),
    output: z.object({ visible: z.boolean() }),
  },
} as const
export const browserEvents = {
  'browser.tabs': TabsSnapshotSchema,
} as const
