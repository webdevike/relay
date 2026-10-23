import { createContext } from 'react'

/** The equal-width cell a node sits in: a grid cell (a button there is a full-width key at a
 * comfortable height) or a horizontal stack's column (a button fills it). `null` elsewhere: cards
 * and vertical stacks reset it so a button nested deeper keeps its own width. */
export const WidgetCell = createContext<'grid' | 'row' | null>(null)
