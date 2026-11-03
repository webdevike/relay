import type { Place } from '@evaos/shell-core'

export interface OpenPlaceOptions {
  newTab?: boolean
}

export type Navigator = (place: Place, opts?: OpenPlaceOptions) => void

let navigator: Navigator | null = null

/** 02-09 binds this to the tabs store; until then openPlace is a no-op. */
export function setNavigator(fn: Navigator | null): void {
  navigator = fn
}

export function openPlace(place: Place, opts?: OpenPlaceOptions): void {
  navigator?.(place, opts)
}
