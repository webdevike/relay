/** The short form of a build id shown to Isaac and put in the surface tag (a git short SHA). */
export function shortBuild(build: string | null): string | null {
  return build ? build.slice(0, 7) : null
}

/**
 * What follows `Relay Desktop` in the surface tag: ` 31e5563` for the running build, then
 * ` · host 0.2.51` when the connected Relay Host said its version. Empty when neither is known.
 */
export function surfaceDetail(build: string | null, hostVersion: string | null): string {
  const sha = shortBuild(build)
  return `${sha ? ` ${sha}` : ''}${hostVersion ? ` · host ${hostVersion}` : ''}`
}
