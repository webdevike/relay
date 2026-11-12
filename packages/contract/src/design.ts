import { z } from 'zod'
import { TabIdSchema } from './browser'

/**
 * Design Mode in a page tab (apps/desktop/docs/design-mode.md): Isaac points at elements of a
 * page, Relay reads what they are (selector, DOM, React source, computed styles, a screenshot crop)
 * and he sends a change for them to the workspace's chat. Main owns the page side (the in-page
 * highlight, input capture, reads); the renderer's design-mode machine owns the mode.
 */

/** The computed styles the inspector shows and lets Isaac edit, in this order. */
export const DESIGN_STYLE_KEYS = [
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'padding',
  'margin',
  'gap',
  'border',
  'border-radius',
  'width',
  'height',
  'display',
  'opacity',
  'box-shadow',
] as const
export const DesignStyleKeySchema = z.enum(DESIGN_STYLE_KEYS)
export type DesignStyleKey = z.output<typeof DesignStyleKeySchema>

/** A selector path as design-page.ts writes it (`>>>` steps into a shadow root). */
export const DesignSelectorSchema = z.string().min(1).max(2048)

export const DesignSourceSchema = z.object({
  /** As the page names it: a project path (`src/Button.tsx`) or the dev server's URL path. */
  file: z.string().max(1024),
  line: z.number().int().min(0).nullable(),
  column: z.number().int().min(0).nullable(),
  /**
   * Where it came from: React's `_debugSource` (exact, React 18 and older), the first app frame of
   * React 19's `_debugStack` (the dev server's generated code, so the line can be off), or a data
   * attribute the project's build writes (`data-source`, `data-inspector-*`, ...).
   */
  via: z.enum(['react-source', 'react-stack', 'data-attribute']),
})
export type DesignSource = z.output<typeof DesignSourceSchema>

export const DesignBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().min(0),
  height: z.number().min(0),
})

/**
 * One selected element as main read it, or a region Isaac dragged (`kind: region`: its crop and
 * box only, a `region-<n>` selector as its key). Every string here comes from the page.
 */
export const DesignItemSchema = z.object({
  kind: z.enum(['element', 'region']),
  selector: DesignSelectorSchema,
  /** `button.primary`: tag, id or first two classes. */
  label: z.string().max(200),
  /** The element is not in the page now (a reload or hot update has not brought it back yet). */
  missing: z.boolean(),
  text: z.string().max(400),
  /** Its outerHTML, trimmed. */
  html: z.string().max(2000),
  box: DesignBoxSchema,
  source: DesignSourceSchema.nullable(),
  /** The React component that rendered it, when the page is a React dev build. */
  component: z.string().max(200).nullable(),
  styles: z.partialRecord(DesignStyleKeySchema, z.string().max(400)),
  /** PNG of the element as the page paints it (no highlight), base64. */
  crop: z
    .object({
      png: z.string().max(8_000_000),
      width: z.number().int().min(1),
      height: z.number().int().min(1),
    })
    .nullable(),
})
export type DesignItem = z.output<typeof DesignItemSchema>

/** A value Isaac changed in the inspector: previewed in the page, sent with the request. */
export const DesignStyleEditSchema = z.object({
  selector: DesignSelectorSchema,
  property: DesignStyleKeySchema,
  /** The computed value before his first edit of it. */
  from: z.string().max(400),
  to: z.string().max(400),
})
export type DesignStyleEdit = z.output<typeof DesignStyleEditSchema>

/** Elements one selection holds at most. */
export const DESIGN_MAX_SELECTION = 8

const okOut = z.object({ ok: z.literal(true) })

export const designInvoke = {
  /** Turns Design Mode on (a fresh, empty selection) or off for page `tabId`. */
  'design.set': {
    input: z.object({ tabId: TabIdSchema, on: z.boolean() }).strict(),
    output: okOut,
  },
  /** Sets the selection (the inspector removing one); answers with a design.selection event. */
  'design.select': {
    input: z
      .object({ tabId: TabIdSchema, selectors: z.array(DesignSelectorSchema).max(8) })
      .strict(),
    output: okOut,
  },
  /** Previews a style value on one selected element (an inline style in the page). */
  'design.style': {
    input: z
      .object({
        tabId: TabIdSchema,
        selector: DesignSelectorSchema,
        property: DesignStyleKeySchema,
        value: z.string().max(200),
      })
      .strict(),
    output: okOut,
  },
  /**
   * Sends Isaac's change for the selected elements to the chat that owns the page, as his message
   * (agent.note's rules: the agent run's chat, else the chat of the page's workspace) with what
   * was read of each present element and its screenshot, the one he drew on (`drawings`, PNG
   * base64 by selector) in place of its crop. `sent` false: no chat owns the page.
   */
  'design.send': {
    input: z
      .object({
        tabId: TabIdSchema,
        instruction: z.string().max(4000),
        items: z.array(DesignItemSchema).max(DESIGN_MAX_SELECTION),
        edits: z.array(DesignStyleEditSchema).max(DESIGN_MAX_SELECTION * DESIGN_STYLE_KEYS.length),
        drawings: z
          .record(DesignSelectorSchema, z.string().max(8_000_000))
          .refine((d) => Object.keys(d).length <= DESIGN_MAX_SELECTION, 'too many drawings'),
      })
      .strict(),
    output: z.object({ sent: z.boolean(), to: z.string().max(200).nullable() }),
  },
} as const

export const designEvents = {
  /**
   * The selection of page `tabId` now: Isaac clicked (`pick`), or its elements changed in the
   * page (`refresh`: a hot update, a reload, a style preview).
   */
  'design.selection': z.object({
    tabId: TabIdSchema,
    items: z.array(DesignItemSchema).max(DESIGN_MAX_SELECTION),
    reason: z.enum(['pick', 'refresh']),
  }),
  /**
   * The page ended the mode: Escape pressed in it, it went to another site, or it closed. `closed`
   * comes for every page that closes, on or not, so the renderer can drop its design actor.
   */
  'design.exit': z.object({
    tabId: TabIdSchema,
    reason: z.enum(['escape', 'navigated', 'closed']),
  }),
} as const
