/** Workspace tags that were renamed; journal and todo rows keep the old names (eva.rs TAG_ALIASES). */
const TAG_ALIASES: Record<string, string> = {
  goodword: 'goodops',
  'eva-app': 'eva-interface',
}

/** Port of eva.rs canonical_tag: sub-tags like `eva/e3` belong to their parent. */
export function canonicalTag(tag: string): string {
  const base = (tag.split('/')[0] ?? tag).trim().toLowerCase()
  return TAG_ALIASES[base] ?? base
}

/** Old names that resolve to `id`. */
export function aliasesFor(id: string): string[] {
  return Object.entries(TAG_ALIASES)
    .filter(([, canonical]) => canonical === id)
    .map(([old]) => old)
}
