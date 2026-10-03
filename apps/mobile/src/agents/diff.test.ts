import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff";

describe("parseDiff", () => {
  it("numbers old/new lines from hunk headers and drops file headers", () => {
    const patch = [
      "diff --git a/x.ts b/x.ts",
      "index 1..2 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -10,3 +10,3 @@ fn",
      " keep",
      "-old",
      "+new",
      " tail",
      "\\ No newline at end of file",
    ].join("\n");
    const { rows, additions, deletions } = parseDiff(patch);
    expect([additions, deletions]).toEqual([1, 1]);
    expect(rows.map((r) => [r.kind, r.oldLine, r.newLine, r.text])).toEqual([
      ["hunk", null, null, "@@ -10,3 +10,3 @@ fn"],
      ["context", 10, 10, "keep"],
      ["del", 11, null, "old"],
      ["add", null, 11, "new"],
      ["context", 12, 12, "tail"],
      ["meta", null, null, "\\ No newline at end of file"],
    ]);
  });

  it("keeps removed lines that look like file headers inside a hunk", () => {
    const { rows, deletions } = parseDiff("@@ -1,1 +0,0 @@\n--- a heading\n");
    expect(deletions).toBe(1);
    expect(rows[1]).toEqual({ kind: "del", text: "-- a heading", oldLine: 1, newLine: null });
  });

  it("renders a bare +/- snippet unnumbered", () => {
    expect(parseDiff("-a\n+b").rows).toEqual([
      { kind: "del", text: "a", oldLine: null, newLine: null },
      { kind: "add", text: "b", oldLine: null, newLine: null },
    ]);
  });
});
