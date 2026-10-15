/** Canonical guard for extensible JSON theme objects at the persistence boundary. */
export function isThemeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
