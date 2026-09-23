import { describe, expect, it } from "vitest";
import { type Block, parseBlocks, parseInline } from "./markdown";

describe("parseInline", () => {
  it("splits inline code out of prose and keeps it literal", () => {
    expect(parseInline("run `bun test` now")).toEqual([
      { text: "run " },
      { text: "bun test", code: true },
      { text: " now" },
    ]);
  });

  it("nests bold and italic", () => {
    expect(parseInline("a **b _c_** d")).toEqual([
      { text: "a " },
      { text: "b ", bold: true },
      { text: "c", bold: true, italic: true },
      { text: " d" },
    ]);
  });

  it("marks strikethrough", () => {
    expect(parseInline("~~gone~~")).toEqual([{ text: "gone", strike: true }]);
  });

  it("leaves snake_case identifiers untouched", () => {
    expect(parseInline("call max_attempts here")).toEqual([{ text: "call max_attempts here" }]);
  });

  it("still italicises underscores at word boundaries", () => {
    expect(parseInline("_hi_ there")).toEqual([{ text: "hi", italic: true }, { text: " there" }]);
  });

  it("parses a link and carries the href onto its label runs", () => {
    expect(parseInline("see [the **PR**](https://x.dev/1)")).toEqual([
      { text: "see " },
      { text: "the ", href: "https://x.dev/1" },
      { text: "PR", bold: true, href: "https://x.dev/1" },
    ]);
  });

  it("autolinks a bare https URL", () => {
    expect(parseInline("go to https://www.amazon.com/dp/B0D4BZHKJM now")).toEqual([
      { text: "go to " },
      { text: "https://www.amazon.com/dp/B0D4BZHKJM", href: "https://www.amazon.com/dp/B0D4BZHKJM" },
      { text: " now" },
    ]);
  });

  it("keeps trailing sentence punctuation out of an autolink", () => {
    expect(parseInline("see https://x.dev/1.")).toEqual([
      { text: "see " },
      { text: "https://x.dev/1", href: "https://x.dev/1" },
      { text: "." },
    ]);
  });

  it("adds an https scheme to a bare www host", () => {
    expect(parseInline("visit www.example.com")).toEqual([
      { text: "visit " },
      { text: "www.example.com", href: "https://www.example.com" },
    ]);
  });

  it("does not autolink inside a markdown link href", () => {
    expect(parseInline("[site](https://x.dev)")).toEqual([{ text: "site", href: "https://x.dev" }]);
  });

  it("leaves a scheme-less word untouched", () => {
    expect(parseInline("the whole thing works")).toEqual([{ text: "the whole thing works" }]);
  });

  it("leaves unbalanced or empty markers literal", () => {
    expect(parseInline("a ` b")).toEqual([{ text: "a ` b" }]);
    expect(parseInline("2 * 3 * 4")).toEqual([{ text: "2 * 3 * 4" }]);
  });
});

describe("parseBlocks", () => {
  it("keeps prose on either side of a fence and lowercases the language", () => {
    expect(parseBlocks("before\n```TS\nconst a = 1;\n```\nafter")).toEqual<Block[]>([
      { kind: "paragraph", inline: [{ text: "before" }] },
      { kind: "code", lang: "ts", code: "const a = 1;" },
      { kind: "paragraph", inline: [{ text: "after" }] },
    ]);
  });

  it("treats an unterminated fence as code so a streaming reply highlights immediately", () => {
    expect(parseBlocks("look:\n```bash\nls -la")).toEqual<Block[]>([
      { kind: "paragraph", inline: [{ text: "look:" }] },
      { kind: "code", lang: "bash", code: "ls -la" },
    ]);
  });

  it("parses headings and horizontal rules", () => {
    expect(parseBlocks("# Title\n\n---")).toEqual<Block[]>([
      { kind: "heading", level: 1, inline: [{ text: "Title" }] },
      { kind: "hr" },
    ]);
  });

  it("parses a bullet list with a nested list", () => {
    const blocks = parseBlocks("- one\n- two\n  - nested\n- three");
    expect(blocks).toEqual<Block[]>([
      {
        kind: "list",
        ordered: false,
        start: 1,
        items: [
          { blocks: [{ kind: "paragraph", inline: [{ text: "one" }] }] },
          {
            blocks: [
              { kind: "paragraph", inline: [{ text: "two" }] },
              { kind: "list", ordered: false, start: 1, items: [{ blocks: [{ kind: "paragraph", inline: [{ text: "nested" }] }] }] },
            ],
          },
          { blocks: [{ kind: "paragraph", inline: [{ text: "three" }] }] },
        ],
      },
    ]);
  });

  it("keeps the ordered-list starting number", () => {
    const [list] = parseBlocks("3. c\n4. d");
    expect(list).toMatchObject({ kind: "list", ordered: true, start: 3 });
  });

  it("parses a pipe table with alignment", () => {
    const [table] = parseBlocks("| a | b |\n| :- | -: |\n| 1 | 2 |");
    expect(table).toEqual<Block>({
      kind: "table",
      header: [[{ text: "a" }], [{ text: "b" }]],
      align: ["left", "right"],
      rows: [[[{ text: "1" }], [{ text: "2" }]]],
    });
  });

  it("parses a blockquote as nested blocks", () => {
    expect(parseBlocks("> quoted **line**")).toEqual<Block[]>([
      { kind: "blockquote", blocks: [{ kind: "paragraph", inline: [{ text: "quoted " }, { text: "line", bold: true }] }] },
    ]);
  });
});
