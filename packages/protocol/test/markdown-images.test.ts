import { describe, expect, it } from "vitest";
import { imageSources, rewriteImages } from "../src/markdown-images";
import signedImages from "../fixtures/signed-images.json";

const SIGNED = "https://private-user-images.githubusercontent.com/1/x.png?jwt=SECRETJWT";
const LOCAL = "/reviews/media/local.png";
/** The private URL to its local copy; everything else kept. */
const map = (url: string): string | undefined => (url === SIGNED ? LOCAL : undefined);
const noSecret = (out: string): void => {
  for (const secret of signedImages.secrets) expect(out).not.toContain(secret);
};

describe("markdown images", () => {
  it.each([
    ["no title", `![a](${SIGNED})`, `![a](${LOCAL})`],
    ["an angle-bracket source", `![a](<${SIGNED}>)`, `![a](${LOCAL})`],
    ["a double-quoted title", `![a](${SIGNED} "The \\"shot\\"")`, `![a](${LOCAL} "The 'shot'")`],
    ["a single-quoted title", `![a](${SIGNED} 'title')`, `![a](${LOCAL} "title")`],
    ["a parenthesized title", `![a](${SIGNED} (title))`, `![a](${LOCAL} "title")`],
    ["a title on the next line", `![a](${SIGNED}\n  'title')`, `![a](${LOCAL} "title")`],
    ["an entity-escaped colon", `![a](https&#58;//private-user-images.githubusercontent.com/1/x.png?jwt=SECRETJWT)`, `![a](${LOCAL})`],
    ["a backslash-escaped destination", `![a](https\\://private-user-images.githubusercontent.com/1/x.png?jwt\\=SECRETJWT)`, `![a](${LOCAL})`],
    ["an `<img>` tag", `<img width="320" alt='a' src="${SIGNED}">`, `![a](${LOCAL} "w=320")`],
    ["an `<img>` with an entity-escaped source", `<img alt="a" src="https&#x3a;//private-user-images.githubusercontent.com/1/x.png?jwt&#61;SECRETJWT">`, `![a](${LOCAL})`],
    ["a linked image repeating its source", `[![a](${SIGNED} "t")](${SIGNED})`, `![a](${LOCAL} "t")`],
    ["a linked image with an angle-bracket destination", `[![a](${SIGNED})](<${SIGNED}>)`, `![a](${LOCAL})`],
    ["a linked image with an entity-escaped destination", `[![a](${SIGNED})](https&#58;//private-user-images.githubusercontent.com/1/x.png?jwt=SECRETJWT)`, `![a](${LOCAL})`],
    ["a linked `<img>`", `[<img src="${SIGNED}" alt="a">](${SIGNED} 'go')`, `![a](${LOCAL})`],
    ["an `<a href>` around an `<img>`", `<a target="_blank" href="${SIGNED}"><img src="${SIGNED}" alt="a"></a>`, `![a](${LOCAL})`],
    ["an `<a href>` block around a markdown image", `<a href='${SIGNED}'>\n![a](${SIGNED})\n</a>`, `\n![a](${LOCAL})\n</a>`],
    ["a reference image", `![a][shot]\n\n[shot]: <${SIGNED}> "t"`, `![a](${LOCAL} "t")\n\n`],
    ["a reference image inside an inline link", `[![a][shot]](${SIGNED})\n\n[shot]: ${SIGNED}`, `![a](${LOCAL})\n\n`],
    ["a reference image inside a reference link", `[![a][shot]][go]\n\n[shot]: ${SIGNED}\n[go]: ${SIGNED}`, `![a](${LOCAL})\n\n\n`],
  ])("rewrites %s inline and leaves no signature", (_, md, expected) => {
    const out = rewriteImages(md, map);
    expect(out).toBe(expected);
    noSecret(out);
    expect(imageSources(md)).toEqual([SIGNED]);
  });

  it.each(Object.entries(signedImages.forms))("lists and rewrites the shared fixture's %s", (_, md) => {
    expect(imageSources(md)).toEqual([signedImages.signed]);
    const out = rewriteImages(md, (url) => (url === signedImages.signed ? LOCAL : undefined));
    expect(out).toContain(`](${LOCAL}`);
    expect(out).not.toMatch(/^\[[^\]]*\]:/m);
    noSecret(out);
  });

  it("keeps a public link around a private image, and an `<a href>` around an `<img>` becomes a markdown link", () => {
    const md = [
      `[![a](${SIGNED})](https://example.com/pr "PR")`,
      `<a href="https://example.com/x"><img src="${SIGNED}" width=40></a>`,
      `x <a href="https://example.com/y"><img src="${SIGNED}"></a> y`,
      `<a><img src="${SIGNED}"></a>`,
    ].join("\n\n");
    expect(rewriteImages(md, map).split("\n\n")).toEqual([
      `[![a](${LOCAL})](https://example.com/pr "PR")`,
      `[![](${LOCAL} "w=40")](https://example.com/x)`,
      `x [![](${LOCAL})](https://example.com/y) y`,
      `![](${LOCAL})`,
    ]);
  });

  it("drops a private link around a public image and replaces a signed private autolink", () => {
    expect(rewriteImages(`[![a](https://example.com/a.png)](${SIGNED})`, map)).toBe("![a](https://example.com/a.png)");
    expect(rewriteImages(`see ${SIGNED} and <${SIGNED}>`, map)).toBe("see (private link) and (private link)");
    expect(rewriteImages(`[the shot](${SIGNED})`, map)).toBe("the shot");
    expect(imageSources(`[![a](https://example.com/a.png)](${SIGNED})`)).toEqual(["https://example.com/a.png"]);
  });

  it("replaces a signed private URL left anywhere in raw HTML", () => {
    const out = rewriteImages(`<details>\n<video src="${SIGNED}"></video>\n</details>`, map);
    expect(out).toBe(`<details>\n<video src="${LOCAL}"></video>\n</details>`);
  });

  it("leaves everything else exactly as written: public images' references, links, definitions and code", () => {
    const md = [
      "Intro *with* `code ![a](" + SIGNED + ")` and __bold__.",
      "![wide](https://example.com/a_(b).png)",
      "![sp](<https://example.com/a b.png>)",
      "[a link](https://example.com/page)",
      "![pub][r]",
      "[r]: https://example.com/r.png",
      '<img alt="none">',
      "![esc \\[1\\]](https://example.com/e.png)",
      "```\n![a](" + SIGNED + ")\n```",
    ].join("\n\n");
    expect(rewriteImages(md, map).split("\n\n")).toEqual([
      "Intro *with* `code ![a](" + SIGNED + ")` and __bold__.",
      "![wide](<https://example.com/a_(b).png>)",
      "![sp](<https://example.com/a b.png>)",
      "[a link](https://example.com/page)",
      "![pub][r]",
      "[r]: https://example.com/r.png",
      '<img alt="none">',
      "![esc 1](https://example.com/e.png)",
      "```\n![a](" + SIGNED + ")\n```",
    ]);
    expect(imageSources(md)).toEqual([
      "https://example.com/a_(b).png",
      "https://example.com/a b.png",
      "https://example.com/r.png",
      "https://example.com/e.png",
    ]);
  });

  it("encodes an `<img>` width as `w=N`, `w=N Title` with a title, from its style too", () => {
    const md = [
      '<img width=400 src="https://example.com/a.png" alt=wide>',
      '<img style="max-width: 90%; width: 320px" src="https://example.com/b.png">',
      '<img width="50%" src="https://example.com/f.png">',
      '<img width="320" title="Login" src="https://example.com/g.png">',
    ].join("\n\n");
    expect(rewriteImages(md, () => undefined).split("\n\n")).toEqual([
      '![wide](https://example.com/a.png "w=400")',
      '![](https://example.com/b.png "w=320")',
      "![](https://example.com/f.png)",
      '![](https://example.com/g.png "w=320 Login")',
    ]);
  });
});

describe("markdown images, cost", () => {
  /** Maps every URL: the strictest map, so any rule that could fire would. */
  const all = (): string => LOCAL;
  const unparsed = [
    "Ticket 12 title: fix the thing",
    "[a link](https://example.com/page) and <https://example.com/x> and https://example.com/bare",
    '<a name="x">anchor</a> <a href="https://example.com/y">y</a> [ref]\n\n[ref]: https://example.com/r',
    "Done? Yes: shipped. [x][r]\n\n[r]: <https://example.com/a b>",
    "<details><summary>Logs</summary>\n\nhttps://example.com/run/1\n</details>",
  ];

  it.each(unparsed)("skips text no rule can change, and the full parse agrees: %s", (md) => {
    expect(rewriteImages(md, all)).toBe(md);
    expect(imageSources(md)).toEqual([]);
    // `&amp;` forces the parse without changing anything: the parsed result must be the text as it was.
    expect(rewriteImages(`${md}\n\n&amp;`, all)).toBe(`${md}\n\n&amp;`);
  });

  const para = (i: number, query: boolean): string =>
    `Comment ${String(i)} looks fine, see [the run](https://github.com/o/r/actions/runs/${String(i)}${query ? "?check=1" : ""}) and \`code\` with **bold** text.\n\n`;
  const body = (query: boolean): string => Array.from({ length: 200 }, (_, i) => para(i, query)).join("");
  const time = (f: () => void): number => {
    const t = performance.now();
    f();
    return performance.now() - t;
  };
  const localize = (md: string): string => {
    imageSources(md);
    return rewriteImages(md, map);
  };

  it("handles 2,000 plain texts and 300 comment bodies of 20 KB well within budget", () => {
    const plain = Array.from({ length: 2000 }, (_, i) => `Ticket ${String(i)}: fix the thing\nDescription with [a link](https://example.com/${String(i)}).`);
    const comments = Array.from({ length: 300 }, () => body(false));
    expect(comments[0]!.length).toBeGreaterThan(20_000);
    expect(time(() => [...plain, ...comments].forEach(localize))).toBeLessThan(1_000);
    // Bodies that must be parsed (a query after a scheme): linear in their size.
    expect(time(() => Array.from({ length: 30 }, () => body(true)).forEach(localize))).toBeLessThan(10_000);
  }, 30_000);

  it("parses in time linear in the text, many raw `<a>` tags included", () => {
    const doc = (n: number): string => Array.from({ length: 1200 * n }, (_, i) => `<a href="https://x.example/${String(i)}?q">${para(i, true)}`).join("");
    const one = time(() => rewriteImages(doc(1), map));
    const ten = time(() => rewriteImages(doc(10), map));
    expect(ten).toBeLessThan(30 * one + 500);
  }, 60_000);
});
