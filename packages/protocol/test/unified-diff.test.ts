import { describe, expect, it } from "vitest";
import { parseDiff, parseHunks, splitPath, splitRows } from "../src/unified-diff";

const DIFF = `diff --git a/README.md b/README.md
index 1..2 100644
--- a/README.md
+++ b/README.md
@@ -4,3 +4,4 @@ intro
 | a |
-| b |
+| b2 |
+| c |
 | d |
diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+one
+two
`;

describe("unified diff", () => {
  it("parses files, numbers lines and counts the unchanged lines before a hunk", () => {
    const files = parseDiff(DIFF);
    expect(files.map((f) => f.path)).toEqual(["README.md", "new.ts"]);
    const h = files[0]!.hunks[0]!;
    expect(h.skipped).toBe(3);
    expect(h.lines.map((l) => [l.kind, l.old, l.new])).toEqual([
      ["ctx", 4, 4],
      ["del", 5, null],
      ["add", null, 5],
      ["add", null, 6],
      ["ctx", 6, 7],
    ]);
    expect(files[1]!.hunks[0]!.lines).toHaveLength(2);
  });

  it("pairs a deletion run with the additions after it in split view", () => {
    const rows = splitRows(parseHunks("@@ -1,2 +1,3 @@\n a\n-b\n+b2\n+c").at(0)!.lines);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["a", "a"],
      ["b", "b2"],
      [null, "c"],
    ]);
    const lonely = splitRows(parseHunks("@@ -1,2 +1,2 @@\n+x\n-y\n-z\n+z2\n q").at(0)!.lines);
    expect(lonely.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      [null, "x"],
      ["y", "z2"],
      ["z", null],
      ["q", "q"],
    ]);
  });

  it("marks binary files and splits a path into folder and name", () => {
    const files = parseDiff(
      "diff --git a/img.png b/img.png\nindex 1..2 100644\nBinary files a/img.png and b/img.png differ\n",
    );
    expect(files).toEqual([{ path: "img.png", hunks: [], binary: true }]);
    expect(splitPath("src/routes/get-tags.route.ts")).toEqual({
      dir: "src/routes/",
      name: "get-tags.route.ts",
    });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});
