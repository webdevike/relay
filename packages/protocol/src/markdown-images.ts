// Images in Reviews markdown (PR descriptions and comments, Linear tickets and comments), for the
// Relay Host and Relay Desktop's main process. Private uploads (GitHub's signed `private-user-images`
// URLs, Linear's signed uploads) must never reach a client, so the markdown is parsed once with the
// grammar the clients render it with (micromark + GFM, as remark-gfm), every URL node is checked,
// and only the nodes that change are written back over their own source range (the rest of the text
// stays byte for byte):
// - an image (`![alt](src "title")`, any title quoting, entity- or backslash-escaped destinations)
//   becomes canonical `![alt](map(src) "title")`;
// - an image reference (`![alt][ref]`) whose definition `map` maps becomes that canonical inline
//   image, and the definition goes, so no client needs reference resolution for a host media path;
// - a link or link reference whose destination `map` maps is unwrapped (its content stays) when it
//   holds an image or its URL carries a query (a signature), and such a bare autolink is replaced;
// - raw HTML: an `<img>` becomes a markdown image (its width as the title `w=N`, `w=N Title` with a
//   title), an `<a href>` around one becomes a markdown link or is dropped like a link, and any other
//   signed URL `map` maps inside raw HTML is replaced by `map`'s answer;
// - last, over the whole output with no grammar (`redactUrls`): every private URL left anywhere (a
//   link label, alt or title, a code span, a destination the AST kept) becomes "(private link)".

import { decodeNamedCharacterReference } from "decode-named-character-reference";
import type { Definition, Html, Image, ImageReference, Link, LinkReference, Nodes, Parent, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/** Maps a URL to where markdown should point instead; undefined keeps it (a public URL). */
export type MapUrl = (url: string) => string | undefined;

export interface MarkdownImage {
  alt: string;
  url: string;
  /** The markdown title: an `<img>`'s width as `w=N` (the renderer's bounded width), followed by its title. */
  title: string | undefined;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

const parse = (md: string): Root => fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });

const startOf = (n: Nodes): number => n.position?.start.offset ?? 0;
const endOf = (n: Nodes): number => n.position?.end.offset ?? 0;

/** A URL with a query string: signed (GitHub's `jwt=`, Linear's `signature=`). */
function signed(url: string): boolean {
  return URL.canParse(url) && new URL(url).search !== "";
}

// ---- Canonical markdown ----

/** A destination as markdown: in `<>` when it holds spaces or parentheses. */
const dest = (url: string): string =>
  /[\s()<>]/.test(url) ? `<${url.replace(/</g, "%3C").replace(/>/g, "%3E")}>` : url;

const titlePart = (t: string | null | undefined): string => {
  const text = (t ?? "").replace(/"/g, "'").replace(/\s+/g, " ").trim();
  return text === "" ? "" : ` "${text}"`;
};

/** An image as markdown pointing at `url`; its text loses brackets and line breaks. */
function markdownImage(i: MarkdownImage, url: string): string {
  const alt = i.alt.replace(/[[\]\n\r]/g, " ").replace(/\s+/g, " ").trim();
  return `![${alt}](${dest(url)}${titlePart(i.title)})`;
}

// ---- Raw HTML: a small attribute parse ----

/** HTML character references (`&#58;`, `&#x3a;`, `&colon;`, `&amp;`) decoded. */
function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|#x[\da-f]+|[a-z][a-z\d]*);/gi, (whole, ref: string) => {
    if (ref.startsWith("#")) {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return decodeNamedCharacterReference(ref) || whole;
  });
}

/** An HTML attribute's value, quoted or not, decoded. */
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`[\\s"'/]${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  const value = m?.[1] ?? m?.[2] ?? m?.[3];
  return value === undefined ? undefined : decodeEntities(value);
}

/** An `<img>`'s pixel width: its `width` attribute, else a `width: Npx` in its style. */
function htmlWidth(tag: string): number | undefined {
  const w =
    /^(\d+)(?:px)?\/?$/i.exec(attr(tag, "width") ?? "")?.[1] ??
    /(?:^|;)\s*width\s*:\s*(\d+)(?:\.\d+)?px/i.exec(attr(tag, "style") ?? "")?.[1];
  return w === undefined || Number(w) === 0 ? undefined : Number(w);
}

/** An `<img>` tag as an image; undefined without a `src`. */
function htmlImage(tag: string): MarkdownImage | undefined {
  const url = attr(tag, "src");
  if (url === undefined) return undefined;
  const width = htmlWidth(tag);
  const title = attr(tag, "title");
  const t = width === undefined ? title : title === undefined || title.trim() === "" ? `w=${String(width)}` : `w=${String(width)} ${title}`;
  return { alt: attr(tag, "alt") ?? "", url, title: t };
}

/** A start tag, quoted attribute values may hold `>`. */
const tag = (name: string): string => String.raw`<${name}\b(?:[^>"']|"[^"]*"|'[^']*')*>`;
const IMG = new RegExp(tag("img"), "gi");
const A_OPEN = new RegExp(tag("a"), "gi");
const A_AROUND_IMG = new RegExp(String.raw`(${tag("a")})\s*(${tag("img")})\s*</a\s*>`, "gi");
const A_OPEN_ONLY = new RegExp(`^${tag("a")}$`, "i");
const A_CLOSE_ONLY = /^<\/a\s*>$/i;
/** Runs that may hold a URL in raw HTML (plain or entity-escaped); scanned once, no backtracking. */
const URL_RUN = /[^\s"'<>()[\]`]+/g;

// ---- The final pass: whole private URLs, wherever they sit ----

/** What a private URL left in text reads as. */
export const PRIVATE_LINK = "(private link)";
/** A `<...>` destination or autolink (spaces and parentheses allowed). */
const ANGLE_URL = /<(https?:\/\/[^<>\n]*)>/gi;
/** A bare URL, parentheses included (its unbalanced closing ones go back to the text). */
const BARE_URL = /https?:\/\/[^\s<>"'[\]`]+/gi;
/** A run between spaces, quotes, brackets and backticks: where an escaped URL (`https&#58;//`, `https\://`) can sit. */
const TOKEN = /[^\s<>"'[\]`]+/g;

/** Text as markdown shows it: HTML character references and backslash escapes decoded. */
const unescape = (s: string): string => decodeEntities(s).replace(/\\([!-/:-@[-`{-~])/g, "$1");

/** A bare URL as PRIVATE_LINK when private, keeping the `)`s that close text around it. */
function bareUrl(url: string, isPrivate: (url: string) => boolean): string {
  const extra = url.split(")").length - url.split("(").length;
  const tail = /\)*$/.exec(url)?.[0].length ?? 0;
  const closing = Math.max(0, Math.min(extra, tail));
  return isPrivate(unescape(url.slice(0, url.length - closing))) ? PRIVATE_LINK + ")".repeat(closing) : url;
}

/** A token holding an escaped private URL (`https&#58;//...`, `&#x3a;`, `&colon;`, `https\://`) as PRIVATE_LINK. */
function escapedUrl(token: string, isPrivate: (url: string) => boolean): string {
  if (!token.includes("&") && !token.includes("\\")) return token;
  return (unescape(token).match(BARE_URL) ?? []).some(isPrivate) ? PRIVATE_LINK : token;
}

/**
 * `text` with every http(s) URL `isPrivate` flags replaced by PRIVATE_LINK wherever it sits: a whole
 * `<...>` destination, a bare URL with parentheses in its path, or one hidden behind HTML entities or
 * backslash escapes. No markdown grammar, so no label, alt, title, code span or destination keeps one.
 * Each step is one linear scan.
 */
export function redactUrls(text: string, isPrivate: (url: string) => boolean): string {
  const angled = text.replace(ANGLE_URL, (whole, url: string) => (isPrivate(unescape(url)) ? PRIVATE_LINK : whole));
  const bare = angled.replace(BARE_URL, (url) => bareUrl(url, isPrivate));
  return bare.replace(TOKEN, (token) => escapedUrl(token, isPrivate));
}

class Rewriter {
  readonly edits: Edit[] = [];
  private readonly defs = new Map<string, Definition>();
  private readonly imageRefs = new Set<string>();

  constructor(
    private readonly md: string,
    private readonly map: MapUrl,
    root: Root,
  ) {
    this.index(root);
  }

  private index(node: Nodes): void {
    if (node.type === "definition" && !this.defs.has(node.identifier)) this.defs.set(node.identifier, node);
    if (node.type === "imageReference") this.imageRefs.add(node.identifier);
    if ("children" in node) for (const c of node.children) this.index(c);
  }

  private edit(start: number, end: number, text: string): void {
    this.edits.push({ start, end, text });
  }

  /** An image as canonical markdown. */
  private image(i: MarkdownImage): string {
    return markdownImage(i, this.map(i.url) ?? i.url);
  }

  /** Whether a link to `url` must go: `map` maps it and it holds an image or a signature. */
  private hidesLink(url: string, holdsImage: boolean): boolean {
    return this.map(url) !== undefined && (holdsImage || signed(url));
  }

  /** Raw HTML with its `<img>` tags as markdown images and private links and signed URLs gone. */
  html(value: string): string {
    const around = value.replace(A_AROUND_IMG, (whole, open: string, img: string) => {
      const i = htmlImage(img);
      const href = attr(open, "href");
      const hidden = href === undefined || this.map(href) !== undefined;
      if (i === undefined) return hidden ? "" : whole;
      return hidden ? this.image(i) : `[${this.image(i)}](${dest(href)}${titlePart(attr(open, "title"))})`;
    });
    const images = around.replace(IMG, (t) => {
      const i = htmlImage(t);
      return i === undefined ? t : this.image(i);
    });
    const links = images.replace(A_OPEN, (t) => {
      const href = attr(t, "href");
      return href !== undefined && this.hidesLink(href, false) ? "" : t;
    });
    return links.replace(URL_RUN, (run) => {
      if (!run.includes("/") && !run.includes("&")) return run;
      const url = decodeEntities(run);
      return url.includes("://") && signed(url) ? (this.map(url) ?? run) : run;
    });
  }

  /** `<a href>` … `</a>` as sibling inline HTML around content: a markdown link, or unwrapped (only around an image, or when signed). */
  private anchor(open: Html, close: Html, inner: Nodes[]): void {
    const href = attr(open.value, "href");
    const hasImage = inner.some(holdsImage);
    const unwrap = (): void => {
      this.edit(startOf(open), endOf(open), "");
      this.edit(startOf(close), endOf(close), "");
    };
    if (href === undefined) {
      if (hasImage) unwrap();
    } else if (this.hidesLink(href, hasImage)) unwrap();
    else if (hasImage) {
      this.edit(startOf(open), endOf(open), "[");
      this.edit(startOf(close), endOf(close), `](${dest(href)}${titlePart(attr(open.value, "title"))})`);
    }
  }

  /** The children of `parent`, pairing inline `<a>` and `</a>` around their content. */
  private children(parent: Parent): void {
    const kids = parent.children as Nodes[];
    const closes = closingAnchors(kids);
    let skipTo = 0;
    for (const [at, kid] of kids.entries()) {
      if (at < skipTo) continue;
      const close = kid.type === "html" && A_OPEN_ONLY.test(kid.value) ? (closes[at] ?? -1) : -1;
      if (close < 0) {
        this.node(kid);
        continue;
      }
      this.anchor(kid as Html, kids[close] as Html, kids.slice(at + 1, close));
      for (const inner of kids.slice(at + 1, close)) this.node(inner);
      skipTo = close + 1;
    }
  }

  /** A link (or a link reference to `url`): unwrapped when private, its content kept. */
  private link(node: Link | LinkReference, url: string): void {
    if (!this.hidesLink(url, holdsImage(node))) {
      this.children(node);
      return;
    }
    const first = node.children[0];
    const last = node.children.at(-1);
    // A bare autolink's text is its signed URL.
    if (first === undefined || last === undefined || startOf(first) === startOf(node) || this.md[startOf(node)] === "<") {
      this.edit(startOf(node), endOf(node), first === undefined ? "" : "(private link)");
      return;
    }
    this.edit(startOf(node), startOf(first), "");
    this.edit(endOf(last), endOf(node), "");
    this.children(node);
  }

  private imageNode(node: Image): void {
    this.edit(startOf(node), endOf(node), this.image({ alt: node.alt ?? "", url: node.url, title: node.title ?? undefined }));
  }

  private imageReference(node: ImageReference): void {
    const def = this.defs.get(node.identifier);
    if (def === undefined || this.map(def.url) === undefined) return;
    this.edit(startOf(node), endOf(node), this.image({ alt: node.alt ?? "", url: def.url, title: def.title ?? undefined }));
  }

  /** Every definition `map` maps that is signed or behind an image goes, the duplicates that never win resolution included. */
  private definition(node: Definition): void {
    const goes = this.map(node.url) !== undefined && (signed(node.url) || this.imageRefs.has(node.identifier));
    if (goes) this.edit(startOf(node), endOf(node), "");
  }

  private htmlNode(node: Html): void {
    const text = this.html(node.value);
    if (text !== node.value) this.edit(startOf(node), endOf(node), text);
  }

  /** The image-side nodes; false for any other. */
  private imageSide(node: Nodes): boolean {
    if (node.type === "image") this.imageNode(node);
    else if (node.type === "imageReference") this.imageReference(node);
    else if (node.type === "definition") this.definition(node);
    else return false;
    return true;
  }

  node(node: Nodes): void {
    if (this.imageSide(node)) return;
    if (node.type === "link") this.link(node, node.url);
    else if (node.type === "linkReference") this.link(node, this.defs.get(node.identifier)?.url ?? "");
    else if (node.type === "html") this.htmlNode(node);
    else if ("children" in node) this.children(node);
  }
}

/** For each sibling, the index of the next `</a>` after it (-1 when none): one pass from the end. */
function closingAnchors(kids: readonly Nodes[]): number[] {
  const closes: number[] = [];
  let next = -1;
  for (let j = kids.length - 1; j >= 0; j -= 1) {
    closes[j] = next;
    const k = kids[j];
    if (k?.type === "html" && A_CLOSE_ONLY.test(k.value)) next = j;
  }
  return closes;
}

function holdsImage(node: Nodes): boolean {
  if (node.type === "image" || node.type === "imageReference") return true;
  if (node.type === "html") return /<img\b/i.test(node.value);
  return "children" in node && (node.children as Nodes[]).some(holdsImage);
}

/** `md` with `edits` applied (each over its own source range, inner ranges never overlapping). */
function apply(md: string, edits: readonly Edit[]): string {
  let out = "";
  let at = 0;
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    if (e.start < at) continue;
    out += md.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + md.slice(at);
}

/**
 * Whether `md` can hold anything `rewriteImages` changes: an image (`![`, `<img`), or a signed URL,
 * whose source has a scheme `:` before its query `?` (either may be entity-escaped, with `&`). Every
 * rule needs one of these, so text without them is returned as it is, unparsed (most ticket and PR
 * text). Each check is one linear scan.
 */
function mayChange(md: string): boolean {
  const colon = md.indexOf(":");
  return md.includes("![") || md.includes("&") || (colon >= 0 && md.lastIndexOf("?") > colon) || /<img\b/i.test(md);
}

/**
 * `md` with every image as canonical markdown `![alt](src "title")` pointing at `map(src)` (its own
 * `src` when `map` keeps it), image references `map` maps made inline (their definitions dropped),
 * private links around images and signed private links unwrapped, and raw HTML `<img>`/`<a>` handled
 * the same way. Then, over the whole result, `redactUrls` with `isPrivate` (by default: a signed URL
 * `map` maps). Text no rule touches stays exactly as written; text no rule can touch is not parsed.
 */
export function rewriteImages(md: string, map: MapUrl, isPrivate: (url: string) => boolean = (url) => signed(url) && map(url) !== undefined): string {
  if (!mayChange(md)) return redactUrls(md, isPrivate);
  const root = parse(md);
  const rewriter = new Rewriter(md, map, root);
  rewriter.node(root);
  return redactUrls(apply(md, rewriter.edits), isPrivate);
}

/** An HTML node's `<img>` sources, and the markdown images an HTML block holds as raw text (markdown once the tags around it go). */
function collectHtml(value: string, defs: Map<string, string>, out: Set<string>): void {
  for (const [t] of value.matchAll(IMG)) {
    const url = htmlImage(t)?.url;
    if (url !== undefined) out.add(url);
  }
  const inner = value.replace(/<[^>]*>/g, "");
  if (inner !== value) collect(parse(inner), defs, out);
}

function collect(node: Nodes, defs: Map<string, string>, out: Set<string>): void {
  const ref = node.type === "imageReference" ? defs.get(node.identifier) : undefined;
  if (node.type === "image") out.add(node.url);
  else if (ref !== undefined) out.add(ref);
  else if (node.type === "html") collectHtml(node.value, defs, out);
  if ("children" in node) for (const c of node.children) collect(c, defs, out);
}

function definitions(node: Nodes, defs: Map<string, string>): void {
  if (node.type === "definition" && !defs.has(node.identifier)) defs.set(node.identifier, node.url);
  if ("children" in node) for (const c of node.children) definitions(c, defs);
}

/** Every image source in `md` (markdown images, image references' definitions, `<img>` tags), once each, in order; none without `![` or `<img`, unparsed. */
export function imageSources(md: string): string[] {
  if (!md.includes("![") && !/<img\b/i.test(md)) return [];
  const root = parse(md);
  const defs = new Map<string, string>();
  definitions(root, defs);
  const out = new Set<string>();
  collect(root, defs, out);
  return [...out];
}
