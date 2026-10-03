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
      ["hunk", null, null, "fn"],
      ["context", 10, 10, "keep"],
      ["del", 11, null, "old"],
      ["add", null, 11, "new"],
      ["context", 12, 12, "tail"],
      ["meta", null, null, "\\ No newline at end of file"],
    ]);
  });

  it("classifies each change block as modified, added, or deleted", () => {
    const patch = ["@@ -1,6 +1,6 @@", "-a", "+A", " b", "+c", " d", "-e", "-f", " g"].join("\n");
    expect(parseDiff(patch).rows.map((r) => r.change)).toEqual([
      null,
      "modified",
      "modified",
      null,
      "added",
      null,
      "deleted",
      "deleted",
      null,
    ]);
  });

  it("keeps removed lines that look like file headers inside a hunk", () => {
    const { rows, deletions } = parseDiff("@@ -1,1 +0,0 @@\n--- a heading\n");
    expect(deletions).toBe(1);
    expect(rows[1]).toEqual({ kind: "del", text: "-- a heading", oldLine: 1, newLine: null, change: "deleted" });
  });

  it("renders a bare +/- snippet unnumbered", () => {
    expect(parseDiff("-a\n+b").rows.map((r) => [r.kind, r.oldLine, r.newLine])).toEqual([
      ["del", null, null],
      ["add", null, null],
    ]);
  });
});
