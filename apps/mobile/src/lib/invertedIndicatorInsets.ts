/**
 * Scroll-indicator insets for an inverted list, in the scroll view's own (native) coordinates.
 *
 * React Native draws an inverted FlatList by flipping its scroll view with `scaleY: -1`, so UIKit's
 * `top` inset is the list's visual bottom and `bottom` is its visual top. Give the insets in what the
 * screen shows (`visualTop`: what covers the top of the list, `visualBottom`: what covers its bottom)
 * and this swaps them. Passed unswapped, the indicator stops a header's height short of the bottom at
 * offset 0 and runs under the composer at the top.
 */
export interface IndicatorInsets {
  top: number;
  bottom: number;
}

export function invertedIndicatorInsets(visualTop: number, visualBottom: number): IndicatorInsets {
  return { top: visualBottom, bottom: visualTop };
}
