import { createContext, useContext } from 'react'
import type { Place } from '@evaos/shell-core'
import { replaceActivePlace } from '../tabs/tabs-store'

/**
 * Where a page settles what it shows without a visit (Canvas picking the newest board): the
 * active app tab in the chat pane, or the page's own tab in a tool pane.
 */
export const ReplacePlaceContext = createContext<(place: Place) => void>(replaceActivePlace)

export function useReplacePlace(): (place: Place) => void {
  return useContext(ReplacePlaceContext)
}
