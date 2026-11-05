// A skill's SKILL.md as the Skills page edits it: a ProseMirror document (Tiptap's schema, the same
// extension list the renderer uses, else y-tiptap sync silently drops nodes) held in a Y.Doc
// (`body` fragment, `front` map), and the way back to the file's exact bytes.
//
// Reserializing a whole markdown file is lossy (tables re-padded, list indents, entities), so the
// body is read one top-level marked token at a time. A block becomes rich nodes only when it parses
// to exactly one valid node and parsing its serialization gives the same node again; anything else
// (HTML blocks, link definitions, unstable parses) is a `rawMarkdown` node holding the exact source.
// Writing back, a node still equal to a block as read emits that block's source and the whitespace
// that followed it, so an unedited doc gives the file back byte for byte and an edit to one block
// changes only that block. The frontmatter is rewritten key by key with `yaml`'s Document API, so
// other keys and comments survive.

import { getSchema, Node as TiptapNode, type AnyExtension, type JSONContent } from "@tiptap/core";
import Code from "@tiptap/extension-code";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { prosemirrorJSONToYXmlFragment, updateYFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { isMap, parseDocument } from "yaml";
import type * as Y from "yjs";

/** Y.Doc keys (contract section 2). */
export const DOC_KEYS = { body: "body", front: "front", state: "state" } as const;

/** Markdown the editor cannot represent faithfully, kept as its exact source (plain monospace text in the editor). */
export const RawMarkdown = TiptapNode.create({
  name: "rawMarkdown",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  parseHTML: () => [{ tag: "pre[data-raw-markdown]", preserveWhitespace: "full" }],
  renderHTML: () => ["pre", { "data-raw-markdown": "" }, ["code", 0]],
  // Never produced by the markdown parser (no tokenizer); this module builds these nodes itself.
  renderMarkdown: (node: JSONContent) => rawText(node),
});

/** The document schema's extensions (contract section 1); the renderer adds only non-schema extensions on top. */
export const SKILL_EXTENSIONS: AnyExtension[] = [
  StarterKit.configure({ undoRedo: false, trailingNode: false, underline: false, code: false }),
  Code.extend({ excludes: "" }),
  TableKit,
  TaskList,
  TaskItem.configure({ nested: true }),
  RawMarkdown,
];

export const skillSchema = getSchema(SKILL_EXTENSIONS);

const markdown = new MarkdownManager({ extensions: SKILL_EXTENSIONS });

/** Node and mark types whose text is literal (no escaping, newlines kept). */
const LITERAL_TYPES: Record<string, true> = { codeBlock: true, rawMarkdown: true, code: true };
const isLiteral = (type: string | undefined): boolean => type !== undefined && LITERAL_TYPES[type] === true;

/**
 * Escapes plain text for markdown, only where a character would change meaning: backslash,
 * backtick, `*`, brackets, `_` that could open or close emphasis (not inside a word, as in
 * `quick_start`), and tildes that could pair into strikethrough; `&` only before something
 * entity-like. `<` stays literal: models read SKILL.md as source, where `<slug>` means `<slug>`.
 * The stock encoder turns every `&`, `<` and `>` into an entity, which rewrites "AT&T" and "->"
 * in every edited block.
 */
export function escapeMarkdownText(text: string): string {
  const tildes = (text.match(/~/g) ?? []).length;
  return text
    .replace(/[\\`*[\]]/g, "\\$&")
    .replace(/(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, "\\_")
    .replace(/~/g, tildes > 1 ? "\\~" : "~")
    .replace(/&(?=[A-Za-z][A-Za-z0-9]*;|#[0-9]{1,7};|#[xX][0-9A-Fa-f]{1,6};)/g, "&amp;");
}

// The manager's text encoder is private and untyped; its signature is (text, node, parent) -> markdown text.
const encoder = markdown as unknown as { encodeTextForMarkdown: (text: string, node: JSONContent, parent?: JSONContent) => string };
encoder.encodeTextForMarkdown = (text, node, parent) => (isLiteral(parent?.type) || (node.marks ?? []).some((mark) => isLiteral(mark.type)) ? text : escapeMarkdownText(text));

function rawText(node: JSONContent): string {
  return (node.content ?? []).map((child) => child.text ?? "").join("");
}

function rawNode(source: string): JSONContent {
  return source === "" ? { type: "rawMarkdown" } : { type: "rawMarkdown", content: [{ type: "text", text: source }] };
}

/** One top-level block as read: its exact source, the whitespace after it, and its node. */
export interface SourceBlock {
  readonly raw: string;
  readonly gap: string;
  readonly node: JSONContent;
  /** `node` as a stable string, the identity the serializer matches on. */
  readonly key: string;
}

/** A markdown body as read: the whitespace before the first block, then the blocks. */
export interface ParsedBody {
  readonly lead: string;
  readonly blocks: readonly SourceBlock[];
}

export const nodeKey = (node: JSONContent): string => JSON.stringify(node);

/** Soft line breaks are spaces in the editor: a paragraph's lines become one line of text. */
function unwrapSoftBreaks(node: JSONContent, literal: boolean): JSONContent {
  if (node.type === "text") return literal || !node.text?.includes("\n") ? node : { ...node, text: node.text.replace(/[ \t]*\n[ \t]*/g, " ") };
  if (node.content === undefined) return node;
  const inner = literal || isLiteral(node.type);
  return { ...node, content: node.content.map((child) => unwrapSoftBreaks(child, inner)) };
}

/** The node in the schema's own JSON form (defaults filled, text merged); throws when invalid. */
function normalize(node: JSONContent): JSONContent {
  const pm = skillSchema.nodeFromJSON(unwrapSoftBreaks(node, false));
  pm.check();
  return pm.toJSON() as JSONContent;
}

/** One node as markdown, without blank lines around it. */
export function serializeNode(node: JSONContent): string {
  if (node.type === "rawMarkdown") return rawText(node);
  return markdown.serialize({ type: "doc", content: [node] }).replace(/^\n+|\n+$/g, "");
}

/** The single node `source` parses to, normalized; null when it is not exactly one valid node. */
function parseOne(source: string): JSONContent | null {
  try {
    const content = markdown.parse(source).content ?? [];
    const only = content.length === 1 ? content[0] : undefined;
    return only === undefined ? null : normalize(only);
  } catch {
    return null;
  }
}

/** `[label]` uses of the body's link definitions: alone they would parse as literal brackets. */
function usesDefinition(source: string, labels: ReadonlySet<string>): boolean {
  if (labels.size === 0) return false;
  for (const match of source.matchAll(/\[([^\]\n]+)\]/g)) if (labels.has((match[1] ?? "").trim().toLowerCase())) return true;
  return false;
}

/**
 * A line that is only an HTML-style tag (`<routing>`, `</quick_start>`): skills use these as
 * section markers for the model, and joining the paragraph's lines would pull the tag mid-line.
 */
const TAG_LINE = /^[ \t]*<\/?[A-Za-z][\w:-]*(?:\s[^<>]*)?>[ \t]*$/m;

function blockNode(source: string, type: string, labels: ReadonlySet<string>): JSONContent {
  if (type === "html" || type === "def" || usesDefinition(source, labels) || (type !== "code" && TAG_LINE.test(source))) return rawNode(source);
  const node = parseOne(source);
  if (node === null) return rawNode(source);
  const again = parseOne(serializeNode(node));
  return again !== null && nodeKey(again) === nodeKey(node) ? node : rawNode(source);
}

interface Token {
  type: string;
  raw: string;
}

/** Splits a markdown body into blocks (see the header). */
export function parseBody(body: string): ParsedBody {
  const tokens = markdown.instance.lexer(body) as unknown as Token[] & { links?: Record<string, unknown> };
  // The lexer normalizes some input (CRLF); then the blocks would not add up to the file: keep it whole.
  if (tokens.map((token) => token.raw).join("") !== body) {
    const lead = /^\s*/.exec(body)?.[0] ?? "";
    const rest = body.slice(lead.length);
    const trimmed = rest.replace(/\s+$/, "");
    if (trimmed === "") return { lead: body, blocks: [] };
    const node = rawNode(trimmed);
    return { lead, blocks: [{ raw: trimmed, gap: rest.slice(trimmed.length), node, key: nodeKey(normalize(node)) }] };
  }
  const labels = new Set(Object.keys(tokens.links ?? {}).map((label) => label.trim().toLowerCase()));
  let lead = "";
  const blocks: { raw: string; gap: string; node: JSONContent; key: string }[] = [];
  for (const token of tokens) {
    const last = blocks.at(-1);
    // Blank lines around a block (some tokenizers include them) belong to the gaps between blocks.
    const raw = token.type === "space" ? "" : token.raw.replace(/^(?:[ \t]*\n)*/, "").replace(/\s+$/, "");
    const start = raw === "" ? token.raw.length : token.raw.indexOf(raw);
    if (last === undefined) lead += token.raw.slice(0, start);
    else last.gap += token.raw.slice(0, start);
    if (raw === "") continue;
    const node = blockNode(raw, token.type, labels);
    blocks.push({ raw, gap: token.raw.slice(start + raw.length), node, key: nodeKey(node) });
  }
  return { lead, blocks };
}

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

/** The ProseMirror doc of a parsed body (one empty paragraph when it has no blocks). */
export function bodyDoc(body: ParsedBody): JSONContent {
  return body.blocks.length === 0 ? EMPTY_DOC : { type: "doc", content: body.blocks.map((block) => block.node) };
}

/**
 * Markdown for `doc` (a doc node's JSON) against the body it was read from: nodes equal to a block
 * as read emit that block's source; consecutive original blocks keep their separator, anything else
 * is separated by a blank line; the lead and the trailing whitespace stay. `hints` maps node keys to
 * source an agent wrote for them, used for nodes no original block matches.
 */
export function serializeBody(doc: JSONContent, base: ParsedBody, hints?: ReadonlyMap<string, string>): string {
  const byKey = new Map<string, number[]>();
  base.blocks.forEach((block, index) => {
    const list = byKey.get(block.key);
    if (list === undefined) byKey.set(block.key, [index]);
    else list.push(index);
  });
  const used = new Set<number>();
  let out = base.lead;
  let wrote = false;
  let previous: number | null = null;
  let lastMatch = -1;
  for (const node of doc.content ?? []) {
    const key = nodeKey(node);
    const candidates = (byKey.get(key) ?? []).filter((index) => !used.has(index));
    const index = candidates.find((candidate) => candidate > lastMatch) ?? candidates[0];
    const text = index === undefined ? (hints?.get(key) ?? serializeNode(node)) : (base.blocks[index]?.raw ?? "");
    // Empty paragraphs (Enter pressed twice) have no markdown.
    if (text.trim() === "") continue;
    if (wrote) out += previous !== null && index === previous + 1 ? (base.blocks[previous]?.gap ?? "\n\n") : "\n\n";
    out += text;
    wrote = true;
    if (index !== undefined) {
      used.add(index);
      lastMatch = index;
    }
    previous = index ?? null;
  }
  return out + (base.blocks.at(-1)?.gap ?? "");
}

/** A SKILL.md as read: its frontmatter and body, and the `front` values seeded from it. */
export interface SkillFile {
  readonly text: string;
  /** The exact frontmatter block (`---\n...\n---\n`), "" when the file has none. */
  readonly header: string;
  /** The frontmatter's YAML, null when the file has none. */
  readonly yaml: string | null;
  readonly name: string;
  readonly description: string;
  readonly body: ParsedBody;
}

const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** Splits `text` into its frontmatter block (and YAML) and body. */
export function splitFrontmatter(text: string): { header: string; yaml: string | null; body: string } {
  const match = FRONTMATTER.exec(text);
  if (match === null) return { header: "", yaml: null, body: text };
  return { header: match[0], yaml: match[1] ?? "", body: text.slice(match[0].length) };
}

/** The frontmatter's top-level keys; empty when it is not a YAML mapping. */
export function frontmatterData(yaml: string | null): Record<string, unknown> {
  if (yaml === null) return {};
  try {
    const document = parseDocument(yaml);
    if (document.errors.length > 0) return {};
    const data: unknown = document.toJS();
    return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Reads a SKILL.md; `fallbackName` (the folder's name) stands in for a missing `name`. */
export function readSkillFile(text: string, fallbackName: string): SkillFile {
  const { header, yaml, body } = splitFrontmatter(text);
  const data = frontmatterData(yaml);
  const name = typeof data["name"] === "string" && data["name"].trim() !== "" ? data["name"] : fallbackName;
  const description = typeof data["description"] === "string" ? data["description"] : "";
  return { text, header, yaml, name, description, body: parseBody(body) };
}

/** The frontmatter for `front` values: untouched when they did not change, else the changed keys set in place. */
function exportHeader(file: SkillFile, name: string, description: string): string {
  const changed: [string, string][] = [];
  if (name !== file.name) changed.push(["name", name]);
  if (description !== file.description) changed.push(["description", description]);
  if (changed.length === 0) return file.header;
  const document = parseDocument(file.yaml ?? "");
  // A header that is not a YAML mapping cannot take keys; it stays as it is.
  if (document.errors.length > 0 || (document.contents !== null && !isMap(document.contents))) return file.header;
  if (file.yaml === null) {
    // No frontmatter before: write both keys, name first.
    document.set("name", name);
    document.set("description", description);
  } else {
    for (const [key, value] of changed) document.set(key, value);
  }
  return `---\n${document.toString({ lineWidth: 0 })}---\n`;
}

const fragmentOf = (doc: Y.Doc): Y.XmlFragment => doc.getXmlFragment(DOC_KEYS.body);
const frontOf = (doc: Y.Doc): Y.Map<unknown> => doc.getMap(DOC_KEYS.front);

/** Fills an empty doc from `file`: the body into `body`, name and description into `front`. */
export function seedDoc(doc: Y.Doc, file: SkillFile, origin: unknown = null): void {
  doc.transact(() => {
    prosemirrorJSONToYXmlFragment(skillSchema, bodyDoc(file.body), fragmentOf(doc));
    const front = frontOf(doc);
    front.set("name", file.name);
    front.set("description", file.description);
  }, origin);
}

/** The doc's body as ProseMirror JSON. */
export function docJSON(doc: Y.Doc): JSONContent {
  return yXmlFragmentToProseMirrorRootNode(fragmentOf(doc), skillSchema).toJSON() as JSONContent;
}

/** The file text the doc stands for now, against `file` (the text as last loaded or saved). */
export function exportText(doc: Y.Doc, file: SkillFile, hints?: ReadonlyMap<string, string>): string {
  const front = frontOf(doc);
  const name = front.get("name");
  const description = front.get("description");
  const header = exportHeader(file, typeof name === "string" ? name : file.name, typeof description === "string" ? description : file.description);
  return header + serializeBody(docJSON(doc), file.body, hints);
}

/** Moves the doc's body to `body` with minimal Yjs changes, so carets in unchanged text stay put. */
export function replaceBody(doc: Y.Doc, body: ParsedBody, origin: unknown = null): void {
  const node = skillSchema.nodeFromJSON(bodyDoc(body));
  const transact = (fn: () => void): void => {
    doc.transact(fn, origin);
  };
  updateYFragment({ transact }, fragmentOf(doc), node, { mapping: new Map(), isOMark: new Map() });
}

/** Replaces body and `front` in place from `file` (a reload from disk). */
export function replaceFromFile(doc: Y.Doc, file: SkillFile, origin: unknown = null): void {
  doc.transact(() => {
    replaceBody(doc, file.body, origin);
    const front = frontOf(doc);
    if (front.get("name") !== file.name) front.set("name", file.name);
    if (front.get("description") !== file.description) front.set("description", file.description);
  }, origin);
}

/** A whole-body edit from markdown (an agent's rewrite): applied in place; returns the parsed blocks. */
export function applyMarkdown(doc: Y.Doc, source: string, origin: unknown = null): ParsedBody {
  const body = parseBody(source);
  replaceBody(doc, body, origin);
  return body;
}
