import { describe, expect, it } from "vitest";
import { changedRanges, diffLines, merge3 } from "../src/text-diff";

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${String(i + 1)}`).join("\n");

/** Applies hunks to `a` the way a consumer does, to prove they rebuild `b`. */
function apply(a: string, b: string): string {
  const base = a.split("\n");
  const out: string[] = [];
  let at = 0;
  for (const h of diffLines(base, b.split("\n"))) {
    while (at < h.baseStart) out.push(base[at++] as string);
    out.push(...h.lines);
    at = h.baseEnd;
  }
  while (at < base.length) out.push(base[at++] as string);
  return out.join("\n");
}

describe("diffLines", () => {
  it("finds nothing for equal text and one hunk per separate change", () => {
    expect(diffLines(["a", "b"], ["a", "b"])).toEqual([]);
    const before = lines(10).split("\n");
    const after = [...before];
    after[1] = "two";
    after.splice(7, 1);
    expect(diffLines(before, after)).toEqual([
      { baseStart: 1, baseEnd: 2, lines: ["two"] },
      { baseStart: 7, baseEnd: 8, lines: [] },
    ]);
  });

  it("rebuilds the new text from the hunks for edits anywhere", () => {
    const cases: Array<[string, string]> = [
      ["", "a\nb"],
      ["a\nb", ""],
      ["a\nb\nc", "x\na\nc\ny"],
      ["a\r\nb\r\n", "a\r\nB\r\nc\r\n"],
      [lines(50), lines(50).replace("line 3\n", "").replace("line 40", "forty\nforty-one")],
      ["a\nb\na\nb\na", "b\na\nb\na\nb"],
      // Past the edit-distance cap: the middle is one rewrite, still exact.
      [lines(3000), lines(3000).replaceAll("line", "row")],
    ];
    for (const [a, b] of cases) expect(apply(a, b)).toBe(b);
  });
});

describe("changedRanges", () => {
  it("names the new text's lines an edit wrote", () => {
    const before = lines(10);
    const after = before.replace("line 4", "four\nfour and a half").replace("line 9", "nine");
    expect(changedRanges(before, after)).toEqual([
      { startLine: 4, endLine: 5 },
      { startLine: 10, endLine: 10 },
    ]);
  });

  it("marks the line after a deletion, or the last line when the cut was at the end", () => {
    expect(changedRanges("a\nb\nc", "a\nc")).toEqual([{ startLine: 2, endLine: 2 }]);
    expect(changedRanges("a\nb\nc", "a")).toEqual([{ startLine: 1, endLine: 1 }]);
  });

  it("reports an append at the end", () => {
    expect(changedRanges("a\n", "a\nb\n")).toEqual([{ startLine: 2, endLine: 2 }]);
  });
});

describe("merge3 (unsaved typing vs an agent's edit)", () => {
  const base = lines(10);

  it("keeps both when they touch different lines", () => {
    const ours = base.replace("line 2", "line 2 typed by Isaac");
    const theirs = base.replace("line 8", "line 8 edited by Nova");
    const r = merge3(base, ours, theirs);
    expect(r).toEqual({ ok: true, text: base.replace("line 2", "line 2 typed by Isaac").replace("line 8", "line 8 edited by Nova") });
  });

  it("keeps an insertion next to a change on the other side", () => {
    const ours = base.replace("line 5", "inserted\nline 5");
    const theirs = base.replace("line 5", "LINE 5");
    expect(merge3(base, ours, theirs)).toEqual({ ok: true, text: base.replace("line 5", "inserted\nLINE 5") });
  });

  it("takes one copy of the same change made on both sides", () => {
    const both = base.replace("line 3", "same");
    expect(merge3(base, both, both)).toEqual({ ok: true, text: both });
    const ours = both.replace("line 9", "mine");
    expect(merge3(base, ours, both)).toEqual({ ok: true, text: ours });
  });

  it("refuses overlapping different changes and two insertions at one spot", () => {
    expect(merge3(base, base.replace("line 4", "Isaac"), base.replace("line 4", "Nova"))).toEqual({ ok: false });
    expect(merge3(base, base.replace("line 4\n", "line 4\nA\n"), base.replace("line 4\n", "line 4\nB\n"))).toEqual({ ok: false });
    // An insertion inside the lines the other side replaced.
    expect(merge3(base, base.replace("line 5", "x\nline 5"), base.replace("line 4\nline 5\nline 6", "gone"))).toEqual({ ok: false });
  });

  it("is the other side when one side did not change", () => {
    const theirs = base.replace("line 1", "first");
    expect(merge3(base, base, theirs)).toEqual({ ok: true, text: theirs });
    expect(merge3(base, theirs, base)).toEqual({ ok: true, text: theirs });
  });
});
