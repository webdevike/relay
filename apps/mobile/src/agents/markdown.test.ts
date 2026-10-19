import { describe, expect, it } from "vitest";
import { type Block, imageBasename, imageSrcKind, parseBlocks, parseInline, previewText, topLevelImages } from "./markdown";

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
      { kind: "code", lang: "ts", code: "const a = 1;", invalid: false },
      { kind: "paragraph", inline: [{ text: "after" }] },
    ]);
  });

  it("treats an unterminated fence as code so a streaming reply highlights immediately", () => {
    expect(parseBlocks("look:\n```bash\nls -la")).toEqual<Block[]>([
      { kind: "paragraph", inline: [{ text: "look:" }] },
      { kind: "code", lang: "bash", code: "ls -la", invalid: false },
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

  it("turns a paragraph that is only an image into an image block", () => {
    expect(parseBlocks("![Cat](https://images.unsplash.com/photo-1?w=800)")).toEqual<Block[]>([
      { kind: "image", src: "https://images.unsplash.com/photo-1?w=800", alt: "Cat" },
    ]);
  });

  it("places an inline image after the paragraph it sits in", () => {
    expect(parseBlocks("Here is **the shot** ![Home](/drops/abc/tok) from the Mac.\nNext line.\n\nAfter")).toEqual<Block[]>([
      {
        kind: "paragraph",
        inline: [{ text: "Here is " }, { text: "the shot", bold: true }, { text: " from the Mac.\nNext line." }],
      },
      { kind: "image", src: "/drops/abc/tok", alt: "Home" },
      { kind: "paragraph", inline: [{ text: "After" }] },
    ]);
  });

  it("makes one block per image when several sit on their own lines", () => {
    expect(parseBlocks("![a](https://x.test/a.png)\n![b](/drops/id/tok)")).toEqual<Block[]>([
      { kind: "image", src: "https://x.test/a.png", alt: "a" },
      { kind: "image", src: "/drops/id/tok", alt: "b" },
    ]);
  });

  it("treats a linked image as the image and drops the link", () => {
    expect(parseBlocks("[![Badge](https://img.test/b.svg)](https://link.test/page)")).toEqual<Block[]>([
      { kind: "image", src: "https://img.test/b.svg", alt: "Badge" },
    ]);
  });

  it("keeps image syntax inside code spans and unfinished images as text", () => {
    expect(parseBlocks("use `![a](b)` here")).toEqual<Block[]>([
      { kind: "paragraph", inline: [{ text: "use " }, { text: "![a](b)", code: true }, { text: " here" }] },
    ]);
    expect(parseBlocks("![a](https://x.test/a.p")).toMatchObject([{ kind: "paragraph" }]);
  });

  it("finds images inside list items and ignores a title after the destination", () => {
    expect(parseBlocks('- ![a](https://x.test/a.png "A title")')).toEqual<Block[]>([
      {
        kind: "list",
        ordered: false,
        start: 1,
        items: [{ blocks: [{ kind: "image", src: "https://x.test/a.png", alt: "a" }] }],
      },
    ]);
  });

  it("hoists top-level images and reports whether prose is left", () => {
    expect(topLevelImages("![a](https://x.test/a.png)\n\n![b](/drops/i/t)")).toEqual({
      images: [
        { src: "https://x.test/a.png", alt: "a" },
        { src: "/drops/i/t", alt: "b" },
      ],
      hasBody: false,
    });
    expect(topLevelImages("Look ![a](https://x.test/a.png)")).toEqual({
      images: [{ src: "https://x.test/a.png", alt: "a" }],
      hasBody: true,
    });
    expect(topLevelImages("- ![a](https://x.test/a.png)")).toEqual({ images: [], hasBody: true });
  });
});

describe("imageSrcKind", () => {
  it("accepts http(s) URLs and the exact drop path `relay-linux share` prints", () => {
    expect(imageSrcKind("https://x.test/a.png")).toBe("remote");
    expect(imageSrcKind("http://x.test/a.png")).toBe("remote");
    expect(imageSrcKind("/drops/6f1c2d3e-0000-4000-8000-123456789abc/" + "ab".repeat(32))).toBe("drop");
  });

  it("treats everything else as a path on the Mac", () => {
    expect(imageSrcKind("/Users/ike/Desktop/shot.png")).toBe("local");
    expect(imageSrcKind("file:///tmp/shot.png")).toBe("local");
    expect(imageSrcKind("/drops/abc")).toBe("local");
    expect(imageSrcKind("shot.png")).toBe("local");
  });
});

describe("imageBasename", () => {
  it("returns the last path segment, decoded and without query", () => {
    expect(imageBasename("/Users/ike/Desktop/Screenshot%202026.png")).toBe("Screenshot 2026.png");
    expect(imageBasename("file:///tmp/shot.png?x=1")).toBe("shot.png");
    expect(imageBasename("shot.png")).toBe("shot.png");
  });
});

describe("previewText", () => {
  it("shows an image-only message as Photo", () => {
    expect(previewText("![Orange cat](https://images.unsplash.com/photo-1?w=800)")).toBe("Photo");
  });

  it("keeps the prose before an image", () => {
    expect(previewText("Here you go ![cat](https://x.test/a.png)")).toBe("Here you go");
  });

  it("drops emphasis and code marks and shows link labels", () => {
    expect(previewText("**Done**: see [the docs](https://x.test) and run `bun test`")).toBe("Done: see the docs and run bun test");
  });

  it("skips blank lines and reads list and heading text", () => {
    expect(previewText("\n# Plan\n- one")).toBe("Plan");
    expect(previewText("- **first** item\n- second")).toBe("first item");
  });

  it("is empty for nothing readable", () => {
    expect(previewText("")).toBe("");
    expect(previewText("---")).toBe("");
  });
});
