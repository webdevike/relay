import { describe, expect, it } from "vitest";
import { parseServerMessage } from "../src/index";
import { ReviewGuide } from "../src/reviews";
import { folderSections, guidePrompt, hunkId, parseGuide, promptDiff, sendDiff, type GuideBody } from "../src/review-guide";
import fixture from "../fixtures/review-guide.json";

const PATHS = fixture.input.files.map((f) => f.path);
const SENT = sendDiff(fixture.input.diff);

type Hunks = { id: string; side?: string; start?: number; end?: number; callouts?: unknown[] }[];
const section = (title: string, hunks: Hunks) => ({ title, explanation: `${title} explained.`, check: ["c"], risks: [], hunks });
/** Three valid sections plus whatever `extra` holds, as the model's text. */
const answer = (extra: object[] = [], first: Hunks = [{ id: "src/policy.ts#3,3" }]): string =>
  JSON.stringify({
    overview: "o",
    risk: "low",
    riskWhy: "r",
    sections: [section("One", first), section("Two", [{ id: "src/route.ts#10,10" }]), section("Three", [{ id: "tests/policy.test.ts#0,1" }]), ...extra],
  });
const parse = (text: string): GuideBody | null => parseGuide(text, SENT, PATHS);

describe("review guide prompt", () => {
  it("annotates each hunk with its id and both sides' line numbers", () => {
    const prompt = guidePrompt(fixture.input, SENT);
    expect(prompt).toContain("HUNK src/policy.ts#3,3");
    expect(prompt).toContain("HUNK src/old.ts#1,0");
    expect(prompt).toContain("FILE src/new-name.ts (renamed from src/old-name.ts)");
    expect(prompt).toContain("FILE src/old.ts (deleted)");
    expect(prompt).toContain("    4       |-export function locked(at: number): boolean {");
    expect(prompt).toContain("          4 |+export function locked(at: number, now = clock()): boolean {");
    expect(prompt).toContain("   20    21 |   if (role === \"admin\") return true;");
    expect(prompt).not.toContain("\u2014");
  });

  it("names files the size cut left out", () => {
    const big = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n${"diff --git a/x b/x\n+y\n".repeat(8_000)}diff --git a/z.ts b/z.ts\n@@ -1 +1 @@\n-z\n+z2\n`;
    const sent = sendDiff(big);
    expect(sent.files.some((f) => f.path === "z.ts")).toBe(false);
    expect(guidePrompt({ title: "t", body: "", files: [{ path: "z.ts", additions: 1, deletions: 1 }], diff: big }, sent)).toContain(
      "FILE z.ts (not shown: the diff was cut for size)",
    );
  });

  it("cuts a long file diff and keeps the next file", () => {
    const out = promptDiff(`diff --git a/x b/x\n${"+y\n".repeat(10_000)}diff --git a/z b/z\n+z\n`);
    expect(out).toContain("[... rest of this file's diff cut]");
    expect(out).toContain("diff --git a/z b/z");
  });
});

describe("review guide answer", () => {
  it("keeps a valid answer: selected hunks, callouts, notCovered, v1 projection", () => {
    const { headSha, source, error, ...body } = fixture.expected;
    expect(parse(fixture.answer)).toEqual(body);
    expect({ headSha, source, error }).toEqual({ headSha: "head1", source: "model", error: null });
    const lock = body.sections[0]!;
    expect(lock.why).toBe(lock.explanation);
    expect(lock.files).toEqual(["src/policy.ts"]);
  });

  it("drops unknown paths and ids, and repeats across sections", () => {
    const g = parse(answer([section("Ghost", [{ id: "nope.ts#1,1" }, { id: "src/route.ts#10,10" }])]))!;
    expect(g.sections.map((s) => s.title)).toEqual(["One", "Two", "Three"]);
  });

  it("drops a hunk whose range is outside it and clamps one that overlaps", () => {
    const g = parse(answer([section("Out", [{ id: "src/policy.ts#20,21", side: "new", start: 90, end: 99 }])], [{ id: "src/policy.ts#3,3", side: "new", start: 1, end: 5 }]))!;
    expect(g.sections.map((s) => s.title)).toEqual(["One", "Two", "Three"]);
    expect(g.sections[0]!.hunks[0]).toMatchObject({ start: 3, end: 5 });
  });

  it("keeps callouts on either side of their hunk and drops the rest", () => {
    const g = parse(
      answer([], [
        {
          id: "src/policy.ts#3,3",
          side: "new",
          callouts: [
            { line: 4, side: "old", note: "old side" },
            { line: 5, note: "new side by default" },
            { line: 7, side: "old", note: "old 7 is not in this hunk" },
            { line: 30, side: "new", note: "outside" },
            { line: 5, side: "new", note: "" },
          ],
        },
      ]),
    )!;
    expect(g.sections[0]!.hunks[0]!.callouts).toEqual([
      { line: 4, side: "old", note: "old side" },
      { line: 5, side: "new", note: "new side by default" },
    ]);
  });

  it("puts a deleted file on the old side and finds a renamed file by its new or old path", () => {
    const g = parse(answer([section("Gone", [{ id: "src/old.ts#1,0", side: "new", start: 1, end: 2 }, { id: "src/old-name.ts#1,1" }])]))!;
    expect(g.sections[3]!.hunks).toEqual([
      { id: "src/old.ts#1,0", path: "src/old.ts", side: "old", start: 1, end: 3, callouts: [] },
      { id: "src/new-name.ts#1,1", path: "src/new-name.ts", side: "new", start: 1, end: 2, callouts: [] },
    ]);
    expect(g.sections[3]!.files).toEqual(["src/old.ts", "src/new-name.ts"]);
  });

  it("drops a reference into text the size cut removed", () => {
    const long = `diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n${Array.from({ length: 800 }, (_, i) => `@@ -${String(100 + i * 10)},1 +${String(100 + i * 10)},1 @@\n-x\n+y\n`).join("")}`;
    const sent = sendDiff(long);
    const ids = sent.files[0]!.hunks.map((h) => hunkId("big.ts", h));
    expect(ids).toContain("big.ts#1,1");
    expect(ids).not.toContain("big.ts#8090,8090");
    const text = JSON.stringify({ sections: [section("A", [{ id: "big.ts#1,1" }]), section("B", [{ id: "big.ts#110,110" }]), section("C", [{ id: "big.ts#8090,8090" }])] });
    expect(parseGuide(text, sent, ["big.ts"])).toBeNull();
    const ok = JSON.stringify({ sections: [section("A", [{ id: "big.ts#1,1" }]), section("B", [{ id: "big.ts#110,110" }]), section("C", [{ id: "big.ts#120,120" }, { id: "big.ts#8090,8090" }])] });
    expect(parseGuide(ok, sent, ["big.ts"])!.sections[2]!.hunks.map((h) => h.id)).toEqual(["big.ts#120,120"]);
  });

  it("enforces 3 to 7 sections, fewer only when the diff has fewer hunks", () => {
    const two = JSON.stringify({ sections: [section("One", [{ id: "src/policy.ts#3,3" }]), section("Two", [{ id: "src/route.ts#10,10" }])] });
    expect(parse(two)).toBeNull();
    const hunks = ["src/policy.ts#3,3", "src/policy.ts#20,21", "src/route.ts#10,10", "src/old.ts#1,0", "src/new-name.ts#1,1", "pnpm-lock.yaml#1,1", "tests/policy.test.ts#0,1"];
    const seven = JSON.stringify({ sections: hunks.map((id, i) => section(`S${String(i)}`, [{ id }])) });
    expect(parse(seven)!.sections).toHaveLength(7);
    const eight = JSON.stringify({ sections: [...hunks, "src/policy.ts#3,3"].map((id, i) => section(`S${String(i)}`, [{ id: i === 7 ? "src/route.ts#10,10" : id }])) });
    expect(parse(eight)!.sections).toHaveLength(7);
    const small = sendDiff("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n");
    expect(parseGuide(JSON.stringify({ sections: [section("Only", [{ id: "a#1,1" }])] }), small, ["a"])!.sections).toHaveLength(1);
    expect(parse("no json here")).toBeNull();
  });

  it("refuses more than 7 sections", () => {
    const many = sendDiff(Array.from({ length: 8 }, (_, i) => `diff --git a/f${String(i)} b/f${String(i)}\n--- a/f${String(i)}\n+++ b/f${String(i)}\n@@ -1 +1 @@\n-a\n+b\n`).join(""));
    const text = JSON.stringify({ sections: Array.from({ length: 8 }, (_, i) => section(`S${String(i)}`, [{ id: `f${String(i)}#1,1` }])) });
    expect(parseGuide(text, many, [])).toBeNull();
  });

  it("lists every changed file no section shows, never as a whole-file section", () => {
    const g = parse(answer())!;
    expect(g.notCovered.map((n) => n.path)).toEqual(["src/old.ts", "src/new-name.ts", "pnpm-lock.yaml"]);
    expect(g.notCovered[0]!.why).toBe("Not part of the walkthrough.");
    expect(g.sections.flatMap((s) => s.files)).not.toContain("pnpm-lock.yaml");
  });
});

describe("review guide record", () => {
  it("parses v1 and v2 records, and old clients still see v1 sections", () => {
    const v1 = { headSha: "h", source: "folders", error: "Claude took too long", sections: folderSections(PATHS) };
    expect(ReviewGuide.parse(v1)).toEqual(v1);
    expect(ReviewGuide.parse(fixture.expected)).toEqual(fixture.expected);
    const frame = parseServerMessage(JSON.stringify({ t: "reviews.res", rid: "g", ok: true, guide: fixture.expected }));
    expect(frame.ok).toBe(true);
    const v1Only = fixture.expected.sections.map(({ title, why, files }) => ({ title, why, files }));
    expect(v1Only[2]).toEqual({ title: "Cleanup", why: "The legacy lock goes away and the name file is renamed.", files: ["src/old.ts", "src/new-name.ts"] });
  });
});
