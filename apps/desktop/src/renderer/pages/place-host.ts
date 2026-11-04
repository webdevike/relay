import { createContext, useContext } from 'react'
import type { Place } from '@evaos/shell-core'
import { replaceTabPlace } from '../tabs/tabs-store'

/**
 * Where a page settles what it shows without a visit (Canvas picking the newest board): its own
 * app tab (AppPanel provides it), the active one by default.
 */
export const ReplacePlaceContext = createContext<(place: Place) => void>(replaceTabPlace)

export function useReplacePlace(): (place: Place) => void {
  return useContext(ReplacePlaceContext)
}

/** True for a page outside the lead pane: the chat it was opened from stays beside it. */
export const InToolPaneContext = createContext(false)

export function useInToolPane(): boolean {
  return useContext(InToolPaneContext)
}
