import { describe, expect, it } from "vitest";
import { parseServerMessage } from "../src/index";
import { ReviewGuide } from "../src/reviews";
import { folderSections, guideRequest, hunkId, MAX_PROMPT_BYTES, parseGuide, REMAINING_TITLE, utf8Bytes, type GuideBody, type GuideInput, type SentDiff } from "../src/review-guide";
import fixture from "../fixtures/review-guide.json";

const PATHS = fixture.input.files.map((f) => f.path);
const request = (input: GuideInput) => {
  const req = guideRequest(input);
  if (req === null) throw new Error("no request");
  return req;
};
const SENT = request(fixture.input).sent;

type Hunks = { id: string; side?: string; start?: number; end?: number; callouts?: unknown[] }[];
const section = (title: string, hunks: Hunks) => ({ title, explanation: `${title} explained.`, check: ["c"], risks: [], hunks });
const prose = { overview: "o", risk: "low", riskWhy: "r", checklist: ["k"] };
/** Three valid sections plus whatever `extra` holds, as the model's text. */
const answer = (extra: object[] = [], first: Hunks = [{ id: "src/policy.ts#3,3" }], over: object = {}): string =>
  JSON.stringify({
    ...prose,
    sections: [section("One", first), section("Two", [{ id: "src/route.ts#10,10" }]), section("Three", [{ id: "tests/policy.test.ts#0,1" }]), ...extra],
    ...over,
  });
const parse = (text: string): GuideBody | null => parseGuide(text, SENT, PATHS);
const file = (path: string, lines: string[], at = 1): string =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${String(at)},1 +${String(at)},${String(lines.length)} @@\n-x\n${lines.map((l) => `+${l}`).join("\n")}\n`;

describe("review guide prompt", () => {
  it("annotates each hunk with its id and both sides' line numbers", () => {
    const { prompt } = request(fixture.input);
    expect(prompt).toContain("HUNK src/policy.ts#3,3");
    expect(prompt).toContain("HUNK src/old.ts#1,0");
    expect(prompt).toContain("FILE src/new-name.ts (renamed from src/old-name.ts)");
    expect(prompt).toContain("FILE src/old.ts (deleted)");
    expect(prompt).toContain("    4       |-export function locked(at: number): boolean {");
    expect(prompt).toContain("          4 |+export function locked(at: number, now = clock()): boolean {");
    expect(prompt).toContain("   20    21 |   if (role === \"admin\") return true;");
    expect(prompt).not.toContain("\u2014");
    expect(SENT.partial).toBe(false);
  });

  it("bounds the final UTF-8 prompt on whole lines, description and file list included", () => {
    // A 100 KB patch of multi-byte lines expands about sevenfold once annotated; the description and file list are huge too.
    const wide = "é".repeat(60) + "\u{1F600}";
    const diff = Array.from({ length: 40 }, (_, i) => file(`src/f${String(i)}.ts`, Array.from({ length: 400 }, () => wide))).join("");
    const input = {
      title: "t".repeat(10_000),
      body: Array.from({ length: 5_000 }, (_, i) => `line ${String(i)} ${"ü".repeat(50)}`).join("\n"),
      files: Array.from({ length: 5_000 }, (_, i) => ({ path: `src/f${String(i)}.ts`, additions: 400, deletions: 1 })),
      diff,
    };
    const { prompt, sent } = request(input);
    expect(utf8Bytes(prompt)).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
    expect(utf8Bytes(prompt)).toBe(Buffer.byteLength(prompt, "utf8"));
    expect(sent.partial).toBe(true);
    const lines = prompt.split("\n");
    // Every annotated line is whole, and every description line is one of the PR's lines.
    for (const l of lines.filter((x) => /^[ \d]{5} [ \d]{5} \|/.test(x))) expect(l === `    1       |-x` || l.endsWith(wide)).toBe(true);
    const body = new Set(input.body.split("\n"));
    const at = lines.indexOf("PR description:");
    for (const l of lines.slice(at + 1, lines.indexOf("[... description cut for size]"))) expect(body.has(l)).toBe(true);
    expect(prompt).toContain("[... description cut for size]");
    expect(prompt).toMatch(/\[\.\.\. \d+ more files\]/);
    expect(prompt).toMatch(/\[\.\.\. \d+ more changed files not shown: the diff was cut for size\]/);
    // What was sent is exactly what the prompt shows.
    const shown = sent.files.flatMap((f) => f.hunks.flatMap((h) => h.lines)).length;
    expect(lines.filter((x) => /^[ \d]{5} [ \d]{5} \|/.test(x))).toHaveLength(shown);
  });

  it("cuts a long file at its own share and keeps the next file", () => {
    const diff = file("big.ts", Array.from({ length: 5_000 }, (_, i) => `y${String(i)}`)) + file("z.ts", ["z2"]);
    const { prompt, sent } = request({ title: "t", body: "", files: [], diff });
    expect(prompt).toContain("[... rest of this file's diff cut for size]");
    expect(prompt).toContain("HUNK z.ts#1,1");
    expect(sent.files.map((f) => f.path)).toEqual(["big.ts", "z.ts"]);
    expect(sent.files[0]!.hunks[0]!.lines.length).toBeLessThan(5_001);
  });

  it("names files the size cut left out, and lists them as not shown", () => {
    const diff = Array.from({ length: 30 }, (_, i) => file(`f${String(i)}.ts`, Array.from({ length: 2_000 }, () => "y"))).join("") + file("z.ts", ["z2"]);
    const req = request({ title: "t", body: "", files: [{ path: "z.ts", additions: 1, deletions: 1 }], diff });
    expect(req.sent.files.some((f) => f.path === "z.ts")).toBe(false);
    expect(req.prompt).toMatch(/more changed files not shown/);
    const text = JSON.stringify({ ...prose, sections: [section("A", [{ id: "f0.ts#1,1" }]), section("B", [{ id: "f1.ts#1,1" }]), section("C", [{ id: "f2.ts#1,1" }, { id: "z.ts#1,1" }])] });
    const g = parseGuide(text, req.sent, ["z.ts"])!;
    expect(g.partial).toBe(true);
    expect(g.sections[2]!.hunks.map((h) => h.id)).toEqual(["f2.ts#1,1"]);
    expect(g.notCovered.find((n) => n.path === "z.ts")?.why).toBe("Not shown to the model: the diff was cut for size.");
  });

  it("keeps a valid late citation after a large early file", () => {
    const diff = file("early.ts", Array.from({ length: 30_000 }, (_, i) => `const v${String(i)} = ${String(i)};`)) + file("late.ts", ["a", "b", "c"], 40);
    expect(diff.length).toBeGreaterThan(300_000);
    const req = request({ title: "t", body: "", files: [], diff });
    expect(req.prompt).toContain("HUNK late.ts#40,40");
    const text = JSON.stringify({ ...prose, sections: [section("Early", [{ id: "early.ts#1,1" }]), section("Late", [{ id: "late.ts#40,40", side: "new", start: 41, end: 42 }])] });
    expect(parseGuide(text, req.sent, ["early.ts", "late.ts"])!.sections[1]!.hunks[0]).toMatchObject({ id: "late.ts#40,40", start: 41, end: 42 });
  });

  it("asks nothing when the PR has no text hunk", () => {
    const binary = "diff --git a/a.png b/a.png\nindex 1..2 100644\nBinary files a/a.png and b/a.png differ\n";
    expect(guideRequest({ title: "t", body: "", files: [{ path: "a.png", additions: 0, deletions: 0 }], diff: binary })).toBeNull();
    expect(guideRequest({ title: "t", body: "", files: [], diff: "" })).toBeNull();
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

  it("projects every changed file exactly once for old clients, the rest in a hunk-less last section", () => {
    const g = parse(answer())!;
    expect(g.sections.at(-1)).toMatchObject({ title: REMAINING_TITLE, hunks: [], files: ["src/old.ts", "src/new-name.ts", "pnpm-lock.yaml"] });
    const files = g.sections.flatMap((s) => s.files);
    expect([...files].sort()).toEqual([...PATHS].sort());
    // A file cited by two sections belongs to the first only.
    const two = parse(answer([section("More policy", [{ id: "src/policy.ts#20,21" }])]))!;
    expect(two.sections.map((s) => s.files)).toEqual([["src/policy.ts"], ["src/route.ts"], ["tests/policy.test.ts"], [], ["src/old.ts", "src/new-name.ts", "pnpm-lock.yaml"]]);
  });

  it("refuses an answer without the required prose or with an unknown risk", () => {
    expect(parse(answer())).not.toBeNull();
    for (const over of [{ overview: "" }, { overview: undefined }, { risk: "severe" }, { risk: undefined }, { riskWhy: " " }, { checklist: [] }, { checklist: undefined }]) {
      expect(parse(answer([], undefined, over))).toBeNull();
    }
  });

  it("drops sections without an explanation or a check, and caps hunks, callouts and lists", () => {
    const bare = [{ title: "No why", check: ["c"], hunks: [{ id: "src/old.ts#1,0" }] }, { title: "No check", explanation: "e", check: [], hunks: [{ id: "src/old.ts#1,0" }] }];
    const g = parse(answer(bare))!;
    expect(g.sections.map((s) => s.title)).toEqual(["One", "Two", "Three", REMAINING_TITLE]);
    const callouts = Array.from({ length: 6 }, () => ({ line: 5, side: "new", note: "n" }));
    const five = ["src/policy.ts#3,3", "src/policy.ts#20,21", "src/old.ts#1,0", "src/new-name.ts#1,1", "pnpm-lock.yaml#1,1"].map((id) => ({ id, callouts }));
    const many = parse(JSON.stringify({ ...prose, checklist: Array.from({ length: 9 }, (_, i) => `k${String(i)}`), sections: [{ ...section("Many", five), check: ["1", "2", "3", "4", "5"], risks: ["1", "2", "3", "4"] }, section("Two", [{ id: "src/route.ts#10,10" }]), section("Three", [{ id: "tests/policy.test.ts#0,1" }])] }))!;
    expect(many.sections[0]!.hunks).toHaveLength(4);
    expect(many.sections[0]!.hunks[0]!.callouts).toHaveLength(3);
    expect(many.sections[0]!.check).toHaveLength(4);
    expect(many.sections[0]!.risks).toHaveLength(3);
    expect(many.checklist).toHaveLength(6);
    // The fifth citation stays free: its file is not covered.
    expect(many.notCovered.map((n) => n.path)).toEqual(["pnpm-lock.yaml"]);
  });

  it("drops unknown paths and ids, and repeats across sections", () => {
    const g = parse(answer([section("Ghost", [{ id: "nope.ts#1,1" }, { id: "src/route.ts#10,10" }])]))!;
    expect(g.sections.map((s) => s.title)).toEqual(["One", "Two", "Three", REMAINING_TITLE]);
  });

  it("drops a hunk whose range is outside it and clamps one that overlaps", () => {
    const g = parse(answer([section("Out", [{ id: "src/policy.ts#20,21", side: "new", start: 90, end: 99 }])], [{ id: "src/policy.ts#3,3", side: "new", start: 1, end: 5 }]))!;
    expect(g.sections.map((s) => s.title)).toEqual(["One", "Two", "Three", REMAINING_TITLE]);
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
    const sent: SentDiff = request({ title: "t", body: "", files: [], diff: long }).sent;
    const ids = sent.files[0]!.hunks.map((h) => hunkId("big.ts", h));
    expect(ids).toContain("big.ts#1,1");
    expect(ids).not.toContain("big.ts#8090,8090");
    const text = JSON.stringify({ ...prose, sections: [section("A", [{ id: "big.ts#1,1" }]), section("B", [{ id: "big.ts#110,110" }]), section("C", [{ id: "big.ts#8090,8090" }])] });
    expect(parseGuide(text, sent, ["big.ts"])).toBeNull();
    const ok = JSON.stringify({ ...prose, sections: [section("A", [{ id: "big.ts#1,1" }]), section("B", [{ id: "big.ts#110,110" }]), section("C", [{ id: "big.ts#120,120" }, { id: "big.ts#8090,8090" }])] });
    expect(parseGuide(ok, sent, ["big.ts"])!.sections[2]!.hunks.map((h) => h.id)).toEqual(["big.ts#120,120"]);
  });

  it("enforces 3 to 7 sections, fewer only when the diff has fewer hunks", () => {
    const two = JSON.stringify({ ...prose, sections: [section("One", [{ id: "src/policy.ts#3,3" }]), section("Two", [{ id: "src/route.ts#10,10" }])] });
    expect(parse(two)).toBeNull();
    const hunks = ["src/policy.ts#3,3", "src/policy.ts#20,21", "src/route.ts#10,10", "src/old.ts#1,0", "src/new-name.ts#1,1", "pnpm-lock.yaml#1,1", "tests/policy.test.ts#0,1"];
    const seven = JSON.stringify({ ...prose, sections: hunks.map((id, i) => section(`S${String(i)}`, [{ id }])) });
    expect(parse(seven)!.sections).toHaveLength(7);
    const eight = JSON.stringify({ ...prose, sections: [...hunks, "src/policy.ts#3,3"].map((id, i) => section(`S${String(i)}`, [{ id: i === 7 ? "src/route.ts#10,10" : id }])) });
    expect(parse(eight)!.sections).toHaveLength(7);
    const small = request({ title: "t", body: "", files: [], diff: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n" }).sent;
    expect(parseGuide(JSON.stringify({ ...prose, sections: [section("Only", [{ id: "a#1,1" }])] }), small, ["a"])!.sections).toHaveLength(1);
    expect(parse("no json here")).toBeNull();
  });

  it("refuses more than 7 sections", () => {
    const many = request({ title: "t", body: "", files: [], diff: Array.from({ length: 8 }, (_, i) => `diff --git a/f${String(i)} b/f${String(i)}\n--- a/f${String(i)}\n+++ b/f${String(i)}\n@@ -1 +1 @@\n-a\n+b\n`).join("") }).sent;
    const text = JSON.stringify({ ...prose, sections: Array.from({ length: 8 }, (_, i) => section(`S${String(i)}`, [{ id: `f${String(i)}#1,1` }])) });
    expect(parseGuide(text, many, [])).toBeNull();
  });

  it("lists every changed file no section shows, never as a concept section", () => {
    const g = parse(answer())!;
    expect(g.notCovered.map((n) => n.path)).toEqual(["src/old.ts", "src/new-name.ts", "pnpm-lock.yaml"]);
    expect(g.notCovered[0]!.why).toBe("Not part of the walkthrough.");
    expect(g.sections.filter((s) => s.hunks.length > 0).flatMap((s) => s.files)).not.toContain("pnpm-lock.yaml");
  });
});

describe("review guide record", () => {
  it("parses v1 and v2 records, and old clients still see every file in v1 sections", () => {
    const v1 = { headSha: "h", source: "folders", error: "Claude took too long", sections: folderSections(PATHS) };
    expect(ReviewGuide.parse(v1)).toEqual(v1);
    expect(ReviewGuide.parse(fixture.expected)).toEqual(fixture.expected);
    const frame = parseServerMessage(JSON.stringify({ t: "reviews.res", rid: "g", ok: true, guide: fixture.expected }));
    expect(frame.ok).toBe(true);
    const v1Only = fixture.expected.sections.map(({ title, why, files }) => ({ title, why, files }));
    expect(v1Only[2]).toEqual({ title: "Cleanup", why: "The legacy lock goes away and the name file is renamed.", files: ["src/old.ts", "src/new-name.ts"] });
    expect(v1Only.flatMap((s) => s.files).sort()).toEqual([...PATHS].sort());
  });
});
