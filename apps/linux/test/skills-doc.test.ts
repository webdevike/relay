import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyMarkdown,
  DOC_KEYS,
  docJSON,
  escapeMarkdownText,
  exportText,
  parseBody,
  readSkillFile,
  seedDoc,
  serializeBody,
  skillSchema,
  type SkillFile,
} from "../src/skills/doc";

const FIXTURE = readFileSync(join(import.meta.dirname, "fixtures", "skill-roundtrip.md"), "utf8");

function seeded(text: string, fallback = "roundtrip"): { doc: Y.Doc; file: SkillFile } {
  const file = readSkillFile(text, fallback);
  const doc = new Y.Doc();
  seedDoc(doc, file);
  return { doc, file };
}

/** The first top-level text node whose text contains `needle`. */
function textWith(doc: Y.Doc, needle: string): Y.XmlText {
  const visit = (type: Y.XmlFragment | Y.XmlElement): Y.XmlText | null => {
    for (const child of type.toArray()) {
      if (child instanceof Y.XmlText && child.toJSON().includes(needle)) return child;
      if (child instanceof Y.XmlElement) {
        const found = visit(child);
        if (found !== null) return found;
      }
    }
    return null;
  };
  const found = visit(doc.getXmlFragment(DOC_KEYS.body));
  if (found === null) throw new Error(`no text with ${needle}`);
  return found;
}

describe("skill document schema", () => {
  it("has exactly the contract's node and mark names", () => {
    expect(Object.keys(skillSchema.nodes).sort().join(" ")).toBe(
      "blockquote bulletList codeBlock doc hardBreak heading horizontalRule listItem orderedList paragraph rawMarkdown table tableCell tableHeader tableRow taskItem taskList text",
    );
    expect(Object.keys(skillSchema.marks).sort().join(" ")).toBe("bold code italic link strike");
  });
});

describe("skill markdown round trip", () => {
  it("gives an unedited doc back byte for byte", () => {
    const { doc, file } = seeded(FIXTURE);
    expect(exportText(doc, file)).toBe(FIXTURE);
    const types = file.body.blocks.map((block) => block.node.type);
    expect(types).toContain("table");
    expect(types).toContain("taskList");
    expect(types).toContain("codeBlock");
    // HTML and link definitions (and the paragraph using one) stay raw source.
    expect(file.body.blocks.filter((block) => block.node.type === "rawMarkdown").map((block) => block.raw)).toEqual([
      "<details>\n<summary>HTML block</summary>",
      "</details>",
      "See [the docs][docs] for more.",
      '[docs]: https://example.com/docs "Docs"',
    ]);
    // The Y.Doc holds exactly the parsed nodes.
    expect(docJSON(doc).content?.map((node) => node.type)).toEqual(types);
    // Bold inline code keeps both marks.
    const paragraph = JSON.stringify(file.body.blocks[1]?.node);
    expect(paragraph).toContain('{"type":"text","marks":[{"type":"bold"},{"type":"code"}],"text":"bold code"}');
  });

  it("keeps a body without frontmatter, and an empty body, as they were", () => {
    for (const text of ["", "\n", "just text", "# Title\n\nbody\n\n\n"]) {
      const { doc, file } = seeded(text);
      expect(exportText(doc, file)).toBe(text);
    }
  });

  it("changes only the edited block", () => {
    const { doc, file } = seeded(FIXTURE);
    const text = textWith(doc, "A quote with ");
    text.insert(text.toJSON().indexOf("A quote") + 2, "short ");
    const out = exportText(doc, file);
    expect(out).toBe(FIXTURE.replace("> A quote with", "> A short quote with"));
  });

  it("re-serializes an edited table and soft-wrapped paragraph, leaving their neighbors alone", () => {
    const { doc, file } = seeded(FIXTURE);
    const cell = textWith(doc, "longer cell");
    cell.insert(0, "a ");
    textWith(doc, "Plain text").insert(0, "Now ");
    const out = exportText(doc, file);
    expect(out).toContain("| a longer cell |");
    // One line now (soft breaks are spaces); the hard break stays a hard break.
    expect(out).toContain(
      "\n\nNow Plain text with AT&T, a -> arrow, `inline code`, **`bold code`** and a [link](https://example.com). A soft line break, and a  \nhard one.\n\n| Column ",
    );
    // Everything before the paragraph and after the table is untouched.
    expect(out.startsWith(FIXTURE.slice(0, FIXTURE.indexOf("Plain text")))).toBe(true);
    expect(out.endsWith(FIXTURE.slice(FIXTURE.indexOf("\n\n- [ ] open task")))).toBe(true);
    // The edits are stable: reading the output back gives the same nodes.
    const again = seeded(out);
    expect(docJSON(again.doc)).toEqual(docJSON(doc));
  });

  it("drops a deleted block with its separator and keeps the trailing newline", () => {
    const { doc, file } = seeded("# A\n\nfirst\n\nsecond\n");
    doc.getXmlFragment(DOC_KEYS.body).delete(2, 1);
    expect(exportText(doc, file)).toBe("# A\n\nfirst\n");
    doc.getXmlFragment(DOC_KEYS.body).delete(0, 1);
    expect(exportText(doc, file)).toBe("first\n");
  });

  it("serializes new blocks with a blank line and skips empty paragraphs", () => {
    const base = parseBody("# A\nfirst\n");
    const doc = {
      type: "doc",
      content: [
        ...base.blocks.map((block) => block.node),
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "new" }] },
      ],
    };
    // The original "\n" between heading and paragraph stays; the new paragraph gets a blank line.
    expect(serializeBody(doc, base)).toBe("# A\nfirst\n\nnew\n");
  });
});

describe("escapeMarkdownText", () => {
  it("escapes only what would change meaning", () => {
    expect(escapeMarkdownText("AT&T -> b > c, 1 < 2, & then")).toBe("AT&T -> b > c, 1 < 2, & then");
    expect(escapeMarkdownText("a*b_c `d` [e] f\\g _lead trail_")).toBe("a\\*b_c \\`d\\` \\[e\\] f\\\\g \\_lead trail\\_");
    expect(escapeMarkdownText("<div> </x> <!-- c")).toBe("<div> </x> <!-- c");
    expect(escapeMarkdownText("&amp; &#38; &#x26; &nbsp")).toBe("&amp;amp; &amp;#38; &amp;#x26; &nbsp");
    expect(escapeMarkdownText("~5 min")).toBe("~5 min");
    expect(escapeMarkdownText("~~gone~~")).toBe("\\~\\~gone\\~\\~");
  });

  it("is what edited text serializes with, and reads back unchanged", () => {
    const tricky = "AT&T -> <slug> *x* _y_ quick_start ~~z~~ &amp; [k] a\\b";
    const { doc, file } = seeded("para\n");
    const text = textWith(doc, "para");
    text.delete(0, 4);
    text.insert(0, tricky);
    const out = exportText(doc, file);
    expect(out).toBe(`${escapeMarkdownText(tricky)}\n`);
    expect(out.startsWith("AT&T -> <slug> \\*x\\* \\_y\\_ quick_start")).toBe(true);
    expect(textWith(seeded(out).doc, "AT&T").toJSON()).toBe(tricky);
  });

  it("keeps a paragraph with a tag-only line as source, so the tag stays on its own line", () => {
    const body = "Then read the run doc and resume.\n</quick_start>\n\n<routing>\nSome text\n</routing>\n";
    const blocks = parseBody(body).blocks;
    expect(blocks.map((block) => block.node.type)).toEqual(["rawMarkdown", "rawMarkdown"]);
  });
});

describe("skill frontmatter", () => {
  it("rewrites only a changed key, keeping comments and other keys", () => {
    const { doc, file } = seeded(FIXTURE);
    doc.getMap(DOC_KEYS.front).set("description", "New description: with a colon.");
    const out = exportText(doc, file);
    expect(out).toContain("# Shown in the skill picker.\nname: roundtrip\n");
    expect(out).toContain('description: "New description: with a colon."\n');
    expect(out).toContain("metadata:\n  owner: isaac # keep\n---\n");
    expect(out.slice(out.indexOf("---\n", 4))).toBe(FIXTURE.slice(FIXTURE.indexOf("---\n", 4)));
  });

  it("writes no frontmatter for a file without one unless name or description changed", () => {
    const { doc, file } = seeded("# Body\n", "plain");
    expect(file.name).toBe("plain");
    expect(exportText(doc, file)).toBe("# Body\n");
    doc.getMap(DOC_KEYS.front).set("description", "Now described");
    expect(exportText(doc, file)).toBe("---\nname: plain\ndescription: Now described\n---\n# Body\n");
  });
});

describe("applyMarkdown", () => {
  it("applies a whole-body rewrite in place, keeping untouched text items", () => {
    const { doc, file } = seeded("# A\n\nkeep this\n\nchange this\n");
    const kept = textWith(doc, "keep this");
    const parsed = applyMarkdown(doc, "# A\n\nkeep this\n\nchanged *now*\n");
    expect(textWith(doc, "keep this")).toBe(kept);
    const hints = new Map(parsed.blocks.map((block) => [block.key, block.raw]));
    expect(exportText(doc, file, hints)).toBe("# A\n\nkeep this\n\nchanged *now*\n");
  });
});
