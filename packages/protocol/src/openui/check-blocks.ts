/** Finds and checks every ```openui block of a Markdown reply; `check.ts` is its CLI. */
import { parseOpenUI, type OpenUIError } from "./parse";

export interface OpenUIBlockFinding {
  /** 1-based line of the opening fence. */
  line: number;
  /** The block's closing fence is missing (checked as a stream prefix). */
  unclosed: boolean;
  /** The root renders and no error (warnings aside) was found. */
  ok: boolean;
  /** The parsed root's `widget` key, or null when nothing renders. */
  widget: string | null;
  complete: boolean;
  errors: OpenUIError[];
}

const OPEN = /^ {0,3}(`{3,}|~{3,})\s*openui\s*$/;

/** Finds every ```openui block in Markdown and checks it. */
export function checkOpenUIBlocks(markdown: string): OpenUIBlockFinding[] {
  const lines = markdown.split(/\r?\n/);
  const findings: OpenUIBlockFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = OPEN.exec(lines[i] ?? "")?.[1];
    if (fence === undefined) continue;
    // Closed by a run of the same fence character at least as long (CommonMark).
    const close = new RegExp(`^ {0,3}${fence.startsWith("`") ? "`" : "~"}{${String(fence.length)},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end] ?? "")) end++;
    const unclosed = end >= lines.length;
    const result = parseOpenUI(lines.slice(i + 1, end).join("\n"), { partial: unclosed });
    findings.push({
      line: i + 1,
      unclosed,
      ok: result.node !== null && result.errors.every((e) => e.severity === "warning"),
      widget: result.node?.widget ?? null,
      complete: result.complete,
      errors: result.errors,
    });
    i = end;
  }
  return findings;
}
