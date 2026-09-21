/**
 * The slice of Markdown a transcript actually needs: fenced code blocks and inline code.
 * Everything else stays literal text. Pure so it is testable without React Native.
 */

export type Segment = { kind: "text"; text: string } | { kind: "code"; lang: string | null; code: string };

export interface Inline {
  code: boolean;
  text: string;
}

const FENCE = /^(`{3,}|~{3,})[ \t]*([\w+#.-]*)[^\n]*$/;

/**
 * Splits on ``` / ~~~ fences. A fence still open at the end of the text (the agent is mid-stream)
 * is a code segment too, so highlighting begins as soon as the fence line lands.
 */
export function splitFences(text: string): Segment[] {
  const out: Segment[] = [];
  const lines = text.split("\n");
  let prose: string[] = [];
  let code: string[] | null = null;
  let lang: string | null = null;
  let closer = "";

  const flushProse = () => {
    const joined = prose.join("\n");
    if (joined.length > 0) out.push({ kind: "text", text: joined });
    prose = [];
  };

  for (const line of lines) {
    if (code === null) {
      const m = FENCE.exec(line);
      if (m) {
        flushProse();
        const [, fence = "", name = ""] = m;
        closer = fence.charAt(0);
        lang = name === "" ? null : name.toLowerCase();
        code = [];
      } else {
        prose.push(line);
      }
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length >= 3 && trimmed === closer.repeat(trimmed.length)) {
      out.push({ kind: "code", lang, code: code.join("\n") });
      code = null;
      continue;
    }
    code.push(line);
  }
  if (code !== null) out.push({ kind: "code", lang, code: code.join("\n") });
  else flushProse();
  return out;
}

/** Splits a prose segment on single-backtick spans. Unbalanced backticks stay literal. */
export function splitInline(text: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let start = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    const end = text.indexOf("`", i + 1);
    if (end === -1 || end === i + 1) {
      i += end === i + 1 ? 2 : 1;
      continue;
    }
    const span = text.slice(i + 1, end);
    if (span.includes("\n")) {
      i = end + 1;
      continue;
    }
    if (i > start) out.push({ code: false, text: text.slice(start, i) });
    out.push({ code: true, text: span });
    i = end + 1;
    start = i;
  }
  if (start < text.length) out.push({ code: false, text: text.slice(start) });
  return out;
}
