import { createContext, useContext } from 'react'

/** How tall and busy rows are: two-line flat rows (option B), or one dense line (option A). */
export type ListDensity = 'comfortable' | 'compact'

/**
 * Columns mode (option C). The first column holds the row's leading, title and meta; the others
 * take ListRow `cells` in order. First column left, the rest centered, numbers right (`end`).
 */
export interface ListColumn {
  id: string
  label: string
  /** A grid track; the first column defaults to minmax(0, 2.4fr), the rest to minmax(0, 1fr). */
  width?: string
  align?: 'start' | 'center' | 'end'
}

export interface ListLayout {
  density: ListDensity
  columns: readonly ListColumn[] | null
}

const ListLayoutContext = createContext<ListLayout>({ density: 'comfortable', columns: null })

export const ListLayoutProvider = ListLayoutContext.Provider

export function useListLayout(): ListLayout {
  return useContext(ListLayoutContext)
}

/** The grid template for a column set. */
export function gridTemplate(columns: readonly ListColumn[]): string {
  return columns
    .map((c, i) => c.width ?? (i === 0 ? 'minmax(0, 2.4fr)' : 'minmax(0, 1fr)'))
    .join(' ')
}
