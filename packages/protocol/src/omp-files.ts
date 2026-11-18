/**
 * What sits in an omp session's folder (`sessions/<dir>/<session stem>/`) beside its subagents.
 * Subagents are `<name>.jsonl` transcripts (with `<name>.md` once they finish), but omp also keeps
 * `changes.jsonl` there: its selective-commit journal (omp `commit/selective/journal.ts`), one record
 * per file-changing tool call for the whole session, with no session header and no `.md`. Read as a
 * subagent it is a chip named "changes" that runs as long as the session works and opens blank.
 */

/** omp's selective-commit journal in a session's folder: never a subagent transcript. */
export const OMP_CHANGE_LOG = "changes.jsonl";

/** Whether `name`, a file directly in a session's (or subagent's) folder, is a subagent transcript. */
export function isSubagentTranscript(name: string): boolean {
  return name.endsWith(".jsonl") && !name.startsWith(".") && name !== OMP_CHANGE_LOG;
}
