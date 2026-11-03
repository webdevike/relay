/**
 * Design systems a prototype (a canvas `proto` node) draws with: the Mantine theme, CSS variables,
 * fonts and components of a real product, so a mockup for it looks like it.
 *
 * - `relay`: Relay Desktop's own look (`relay.ts`).
 * - `ecard`: eCard's design-system layer, a snapshot from its repo (`ecard.ts`,
 *   generated/ecard/, refreshed by scripts/sync-ecard-design.ts).
 * - `mantine`: stock Mantine, no theme.
 *
 * The runtime side (theme objects, components) is runtime/systems.tsx; the page side (global CSS,
 * fonts) is `css.ts`. This module is data only, safe for the host to import.
 */
export const DESIGN_SYSTEMS = ["relay", "ecard", "mantine"] as const;
export type DesignSystem = (typeof DESIGN_SYSTEMS)[number];

export function isDesignSystem(value: unknown): value is DesignSystem {
  return (DESIGN_SYSTEMS as readonly unknown[]).includes(value);
}

/** A prototype's screen: `desktop` fills its card, `mobile` is a phone-width column. */
export const PROTO_VIEWPORTS = ["desktop", "mobile"] as const;
export type ProtoViewport = (typeof PROTO_VIEWPORTS)[number];

/** The page width of a `mobile` prototype, in CSS pixels (an iPhone's portrait width). */
export const MOBILE_VIEWPORT_WIDTH = 390;
