import { z } from 'zod'

// Files panel: a slim editor over one root folder (the open chat's worktree, else the Eva root).
// Every call names its root; main serves only roots it resolved itself through `files.root`.

const RootSchema = z.string().min(1).max(4096).startsWith('/')
/** A path relative to the root, `/`-separated, '' for the root itself. Main re-checks containment. */
export const RelPathSchema = z
  .string()
  .max(4096)
  .refine((p) => !p.includes('\0') && !p.startsWith('/'), 'relative path expected')

export const FileEntrySchema = z
  .object({
    name: z.string(),
    /** Root-relative path. */
    path: z.string(),
    kind: z.enum(['file', 'dir']),
    /** A symlink whose target stays inside the root (followed like the real entry). */
    symlink: z.boolean(),
    /** Listed but not readable: secrets, or a symlink that leaves the root. */
    locked: z.boolean(),
  })
  .strict()
export type FileEntry = z.infer<typeof FileEntrySchema>

/** What a file was when read; a save refuses when the disk no longer matches. */
export const FileVersionSchema = z
  .object({ mtimeMs: z.number(), size: z.number().int().nonnegative(), hash: z.string().max(128) })
  .strict()
export type FileVersion = z.infer<typeof FileVersionSchema>

export const FileContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string(), version: FileVersionSchema }).strict(),
  z
    .object({
      kind: z.literal('image'),
      mime: z.string(),
      dataUrl: z.string(),
      size: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ kind: z.literal('binary'), size: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('too-large'), size: z.number().int().nonnegative() }).strict(),
])
export type FileContent = z.infer<typeof FileContentSchema>

/**
 * Git state of a path, VS Code letters: M modified, A added (staged new), U untracked,
 * D deleted, R renamed, C conflicted. Ignored paths come separately.
 */
export const GitCodeSchema = z.enum(['M', 'A', 'U', 'D', 'R', 'C'])
export type GitCode = z.infer<typeof GitCodeSchema>

export const GitStatusSchema = z
  .object({
    /** False when the root is not inside a git checkout (nothing else is set then). */
    repo: z.boolean(),
    branch: z.string().nullable(),
    /** Root-relative path to its code; paths outside the root are dropped. */
    changes: z.record(z.string(), GitCodeSchema),
    /** Root-relative ignored paths; a directory ends with '/' and covers everything below. */
    ignored: z.array(z.string()),
  })
  .strict()
export type GitStatus = z.infer<typeof GitStatusSchema>

export const SearchMatchSchema = z
  .object({
    /** 1-based line and column (UTF-16 units), like Monaco positions. */
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    length: z.number().int().nonnegative(),
    /** The line, trimmed to a window around the match. */
    preview: z.string(),
    /** Where the match starts inside `preview`. */
    previewStart: z.number().int().nonnegative(),
  })
  .strict()
export type SearchMatch = z.infer<typeof SearchMatchSchema>

export const SearchResultSchema = z
  .object({
    results: z.array(z.object({ path: z.string(), matches: z.array(SearchMatchSchema) }).strict()),
    /** True when the match cap cut the results short. */
    truncated: z.boolean(),
    engine: z.enum(['rg', 'git', 'scan']),
  })
  .strict()
export type SearchResult = z.infer<typeof SearchResultSchema>

const rootIn = { root: RootSchema }

export const filesInvoke = {
  /** Resolves the root for a chat session file (its active worktree, else its cwd) or the Eva root. */
  'files.root': {
    input: z.object({ file: z.string().min(1).max(4096).startsWith('/').nullable() }).strict(),
    output: z.object({ root: z.string(), name: z.string() }).strict(),
  },
  /**
   * Opens an assistant's two instruction files (prime.md, thread.md) in the Files panel: the root
   * to show and the root-relative paths. On a thin client the files are the Mini's, behind a
   * virtual root served through the Mini's Relay Host; nothing else of it is reachable.
   */
  'files.agent': {
    input: z
      .object({
        agent: z
          .string()
          .regex(/^[a-z][a-z0-9-]*$/)
          .max(64),
      })
      .strict(),
    output: z
      .object({
        root: z.string(),
        name: z.string(),
        prime: z.string(),
        thread: z.string(),
        remote: z.boolean(),
      })
      .strict(),
  },
  /** One folder's entries: folders first, then case-insensitive by name. `.git` is never listed. */
  'files.list': {
    input: z.object({ ...rootIn, dir: RelPathSchema }).strict(),
    output: z.object({ entries: z.array(FileEntrySchema) }).strict(),
  },
  'files.read': {
    input: z.object({ ...rootIn, path: RelPathSchema }).strict(),
    output: FileContentSchema,
  },
  /**
   * Atomic save of an existing text file. `expected` is the version the editor loaded; the save
   * fails with `changed-on-disk` when the file no longer matches it, unless `force`.
   */
  'files.save': {
    input: z
      .object({
        ...rootIn,
        path: RelPathSchema,
        text: z.string().max(20_000_000),
        expected: FileVersionSchema.nullable(),
        force: z.boolean(),
      })
      .strict(),
    output: z.object({ version: FileVersionSchema }).strict(),
  },
  'files.gitStatus': {
    input: z.object(rootIn).strict(),
    output: GitStatusSchema,
  },
  /** Every non-ignored file under the root, for quick open. */
  'files.all': {
    input: z.object(rootIn).strict(),
    output: z.object({ files: z.array(z.string()), truncated: z.boolean() }).strict(),
  },
  'files.search': {
    input: z
      .object({
        ...rootIn,
        query: z.string().min(1).max(1000),
        regex: z.boolean(),
        caseSensitive: z.boolean(),
        wholeWord: z.boolean(),
      })
      .strict(),
    output: SearchResultSchema,
  },
  /** Replaces the watched set: expanded folders and open files, root-relative. */
  'files.watch': {
    input: z.object({ ...rootIn, paths: z.array(RelPathSchema).max(2000) }).strict(),
    output: z.object({}).strict(),
  },
  'files.reveal': {
    input: z.object({ ...rootIn, path: RelPathSchema }).strict(),
    output: z.object({}).strict(),
  },
} as const

export const filesEvents = {
  /** Debounced: watched paths that changed (a folder's listing, or a file's content). */
  'files.changed': z.object({ root: z.string(), paths: z.array(z.string()) }).strict(),
} as const
