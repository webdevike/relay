// Images in Reviews markdown (PR descriptions and comments, Linear tickets and comments), parsed
// once for the Relay Host and Relay Desktop's main process. Private uploads (GitHub's signed
// `private-user-images` URLs, Linear's) must never reach a client, so every image form the clients'
// markdown renders is recognized here: `![alt](src)` and `![alt](<src>)` with a `"`, `'` or `( )`
// title or none, HTML `<img>` (any attribute quoting), a link around one (`[![alt](src)](dest)`,
// `[<img src=...>](dest)`, `<a href="dest"><img src=...></a>`) and reference definitions
// (`[ref]: src`, behind `![alt][ref]`). Each image becomes canonical markdown with its source passed
// through the caller's map; an `<img>`'s width travels as the title `w=N` (`w=N Title` with a title).
// Pure, no imports.

/** An image's text: escapes and one level of balanced brackets. */
const ALT = String.raw`(?:[^\[\]\\]|\\[\s\S]|\[[^\[\]]*\])*`;
/** A link destination: `<...>` (spaces allowed), or bare (no spaces, balanced parentheses). */
const DEST = String.raw`<(?:[^<>\n\\]|\\.)*>|(?:[^\s()<>\\]|\\.|\((?:[^\s()\\]|\\.)*\))+`;
const TITLE = String.raw`"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|\((?:[^()\\]|\\[\s\S])*\)`;
const LABEL = String.raw`(?:[^\[\]\\]|\\.)+`;

const group = (re: string, capture: boolean): string => (capture ? `(${re})` : `(?:${re})`);
/** An HTML start tag, quoted attribute values may hold `>`. */
const tag = (name: string): string => String.raw`<${name}\b(?:[^>"']|"[^"]*"|'[^']*')*>`;
const IMG = tag("img");
/** `(dest "title")` after an image's or link's text. */
const target = (c: boolean): string => String.raw`\(\s*${group(DEST, c)}(?:\s+${group(TITLE, c)})?\s*\)`;
const mdImage = (c: boolean): string => String.raw`!\[${group(ALT, c)}\]${target(c)}`;
const INNER = `(?:${mdImage(false)}|${IMG})`;
const linked = (c: boolean): string => String.raw`\[\s*${group(INNER, c)}\s*\]${target(c)}`;
const anchor = (c: boolean): string => String.raw`${group(tag("a"), c)}\s*${group(INNER, c)}\s*</a\s*>`;
const definition = (c: boolean): string =>
  String.raw`^ {0,3}\[${group(LABEL, c)}\]:[ \t]*\n?[ \t]*${group(DEST, c)}(?:\s+${group(TITLE, c)})?[ \t]*$`;

/** Every form, links before the images they hold. */
const ANY = new RegExp([linked, anchor, mdImage, () => IMG, definition].map((f) => f(false)).join("|"), "gim");
const LINKED = new RegExp(`^${linked(true)}$`, "i");
const ANCHOR = new RegExp(`^${anchor(true)}$`, "i");
const MD_IMAGE = new RegExp(`^${mdImage(true)}$`);
const DEFINITION = new RegExp(`^${definition(true)}$`);

/** An HTML attribute's value, quoted or not. */
function attr(html: string, name: string): string | undefined {
  const m = new RegExp(`[\\s"'/]${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(html);
  return m?.[1] ?? m?.[2] ?? m?.[3];
}

/** Markdown text without its backslash escapes. */
const unescape = (s: string): string => s.replace(/\\([!-/:-@[-`{-~])/g, "$1");
const destUrl = (dest: string): string => unescape(dest.startsWith("<") ? dest.slice(1, -1) : dest);
const titleText = (title: string | undefined): string | undefined =>
  title === undefined ? undefined : unescape(title.slice(1, -1));

/** An `<img>`'s pixel width: its `width` attribute, else a `width: Npx` in its style. */
function htmlWidth(html: string): number | undefined {
  const w =
    /^(\d+)(?:px)?\/?$/i.exec(attr(html, "width") ?? "")?.[1] ??
    /(?:^|;)\s*width\s*:\s*(\d+)(?:\.\d+)?px/i.exec(attr(html, "style") ?? "")?.[1];
  return w === undefined || Number(w) === 0 ? undefined : Number(w);
}

export interface MarkdownImage {
  alt: string;
  url: string;
  /** The markdown title: an `<img>`'s width as `w=N` (the renderer's bounded width), followed by its title. */
  title: string | undefined;
}

/** An `<img>`'s markdown title: `w=N`, `w=N <title>` when it has both, else its title. */
function widthTitle(width: number | undefined, title: string | undefined): string | undefined {
  if (width === undefined) return title;
  return title === undefined || title.trim() === "" ? `w=${String(width)}` : `w=${String(width)} ${title}`;
}

/** One image, markdown or `<img>`; undefined for an `<img>` without a `src`. */
function image(text: string): MarkdownImage | undefined {
  const md = MD_IMAGE.exec(text);
  if (md !== null) return { alt: unescape(md[1] ?? ""), url: destUrl(md[2] ?? ""), title: titleText(md[3]) };
  const src = attr(text, "src");
  if (src === undefined) return undefined;
  return { alt: attr(text, "alt") ?? "", url: src, title: widthTitle(htmlWidth(text), attr(text, "title")) };
}

interface Link {
  url: string;
  title: string | undefined;
}

/** One match: an image (with the link around it), or a reference definition. */
type Piece =
  | { kind: "image"; image: MarkdownImage | undefined; link: Link | undefined }
  | { kind: "definition"; label: string; link: Link };

/** An `<a>` start tag's link; none without an `href`. */
function anchorLink(open: string): Link | undefined {
  const href = attr(open, "href");
  return href === undefined ? undefined : { url: href, title: attr(open, "title") };
}

function piece(whole: string): Piece {
  const md = LINKED.exec(whole);
  if (md !== null)
    return { kind: "image", image: image(md[1] ?? ""), link: { url: destUrl(md[2] ?? ""), title: titleText(md[3]) } };
  const a = ANCHOR.exec(whole);
  if (a !== null) return { kind: "image", image: image(a[2] ?? ""), link: anchorLink(a[1] ?? "") };
  const def = DEFINITION.exec(whole);
  if (def !== null)
    return { kind: "definition", label: def[1] ?? "", link: { url: destUrl(def[2] ?? ""), title: titleText(def[3]) } };
  return { kind: "image", image: image(whole), link: undefined };
}

/** A destination as markdown: in `<>` when it holds spaces or parentheses. */
const dest = (url: string): string =>
  /[\s()<>]/.test(url) ? `<${url.replace(/</g, "%3C").replace(/>/g, "%3E")}>` : url;

const title = (t: string | undefined): string => {
  const text = (t ?? "").replace(/"/g, "'").replace(/\s+/g, " ").trim();
  return text === "" ? "" : ` "${text}"`;
};

/** An image as markdown pointing at `url`; its text loses brackets and line breaks. */
function markdownImage(i: MarkdownImage, url: string): string {
  const alt = i.alt.replace(/[[\]\n\r]/g, " ").replace(/\s+/g, " ").trim();
  return `![${alt}](${dest(url)}${title(i.title)})`;
}

/** Maps a URL to where markdown should point instead; undefined keeps it. */
export type MapUrl = (url: string) => string | undefined;

function rewrite(whole: string, p: Piece, map: MapUrl): string {
  if (p.kind === "definition") {
    const to = map(p.link.url);
    return to === undefined ? whole : `[${p.label}]: ${dest(to)}${title(p.link.title)}`;
  }
  const hidden = p.link !== undefined && map(p.link.url) !== undefined;
  if (p.image === undefined) return hidden ? "" : whole;
  const img = markdownImage(p.image, map(p.image.url) ?? p.image.url);
  return p.link === undefined || hidden ? img : `[${img}](${dest(p.link.url)}${title(p.link.title)})`;
}

/**
 * `md` with every image as canonical markdown `![alt](src "title")` pointing at `map(src)` (its own
 * `src` when `map` keeps it). A link around an image stays as a markdown link (an `<a href>` becomes
 * one) unless `map` maps its destination: that destination is private (often the same signed URL as
 * the image), so the link is dropped and the image alone stays. A reference definition's destination
 * is replaced by `map`'s answer when it has one.
 */
export function rewriteImages(md: string, map: MapUrl): string {
  return md.replace(ANY, (whole) => rewrite(whole, piece(whole), map));
}

/** Every image source in `md` and every reference definition's destination, once each, in order. */
export function imageSources(md: string): string[] {
  const urls = new Set<string>();
  for (const [whole] of md.matchAll(ANY)) {
    const p = piece(whole);
    const url = p.kind === "definition" ? p.link.url : p.image?.url;
    if (url !== undefined) urls.add(url);
  }
  return [...urls];
}
