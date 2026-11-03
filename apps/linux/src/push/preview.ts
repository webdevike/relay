// What a notification shows of an assistant reply: plain text from its opening, like a message
// preview. Markdown goes (headings, lists, quotes, emphasis, links keep their text, images and
// code blocks drop), any `[[replies: ...]]` token goes, and the first line's sentences are kept up
// to `max` characters, ending on a whole sentence where one fits. A heading (or a bold-only line)
// or a lead-in ending in ":" takes the line after it. A reply that is only code, a widget or images
// says so.

const FENCE = /^\s*(```|~~~)\s*([\w-]*)/;
const WIDGETS: Record<string, true> = { "html-widget": true, "mantine-widget": true };

/** One markdown line as plain text; "" for a line with nothing to read (a rule, a table divider). */
function plainLine(line: string): string {
  let text = line.trim();
  if (/^([-*_]\s*){3,}$/.test(text) || /^\|?\s*:?-{2,}/.test(text)) return "";
  text = text
    .replace(/^(>\s*)+/, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^([-*+]|\d{1,3}[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "");
  if (text.startsWith("|")) text = text.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()).filter((cell) => cell !== "").join(", ");
  return text
    .replace(/\[\[replies:[^\]\n]*\]\]/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The reply's readable lines, in order, outside code fences; with what the fences held. */
function readable(markdown: string): { lines: string[]; fences: string[] } {
  const lines: string[] = [];
  const fences: string[] = [];
  let fence: string | null = null;
  for (const raw of markdown.split(/\r?\n/)) {
    const open = FENCE.exec(raw);
    if (fence !== null) {
      if (open !== null && open[1] === fence && raw.trim() === fence) fence = null;
      continue;
    }
    if (open !== null) {
      fence = open[1] ?? "```";
      fences.push(open[2] ?? "");
      continue;
    }
    const text = plainLine(raw);
    if (text === "") continue;
    const heading = /^\s*#{1,6}\s/.test(raw) || /^\s*(\*\*|__)[^*_]+\1\s*$/.test(raw);
    lines.push(heading && !/[.:!?…]$/.test(text) ? `${text}:` : text);
  }
  return { lines, fences };
}

/** The whole sentences of `line` that fit in `max`, else its first `max - 1` characters cut at a word, with "…". */
function opening(line: string, max: number): string {
  if (line.length <= max) return line;
  let kept = "";
  for (const sentence of line.match(/.+?(?:[.!?…]+["')\]]*(?=\s|$)|$)\s*/g) ?? []) {
    const next = kept + sentence;
    if (next.trimEnd().length > max) break;
    kept = next;
  }
  if (kept.trim() !== "") return kept.trimEnd();
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
}

export function pushPreview(markdown: string, max: number): string {
  const { lines, fences } = readable(markdown);
  const first = lines[0];
  if (first === undefined) {
    if (fences.some((lang) => WIDGETS[lang] === true)) return "Sent a widget";
    if (fences.length > 0) return "Sent code";
    return /!\[[^\]]*\]\([^)]*\)/.test(markdown) ? "Sent an image" : "";
  }
  const second = lines[1];
  const line = first.endsWith(":") && second !== undefined ? `${first} ${second}` : first.replace(/:$/, "");
  return opening(line, max);
}
