/** 120ms overlay transition, 0 when the motion setting is off (read at render time). */
export function overlayTransitionDuration(): number {
  return document.documentElement.getAttribute('data-eva-motion') === 'off' ? 0 : 120
}
