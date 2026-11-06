// An assistant planning an `@computer` run in its own thread (apps/desktop SPEC: "The assistant
// owns the run") answers in its voice and ends its reply with one fenced block:
//
//   ```computer-plan
//   {"run": "<id>", "brief": "...", "steps": [...]}
//   ```
//
// Relay Desktop reads the block from the session file and hands it to the run; the chat never
// shows it. A block still streaming (no closing fence yet) is cut from its opener on.

const BLOCK = /\n?[ \t]*```computer-plan[ \t]*\n([\s\S]*?)\n[ \t]*```[ \t]*(?=\n|$)/g
const OPEN = /\n?[ \t]*```computer-plan\b[\s\S]*$/

/** `text` without its `computer-plan` blocks (and a trailing unclosed one), trimmed at the end. */
export function stripComputerPlan(text: string): string {
  if (!text.includes('```computer-plan')) return text
  return text.replace(BLOCK, '').replace(OPEN, '').trimEnd()
}

/** The bodies of the `computer-plan` blocks in `text`, in order. */
export function computerPlanBlocks(text: string): string[] {
  return [...text.matchAll(BLOCK)].map((m) => m[1] ?? '')
}
