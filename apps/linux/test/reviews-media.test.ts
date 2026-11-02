import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewMedia } from "../src/reviews/linear";
import { isGithubUpload, isLinearUpload, localizeImages, slackFetchScript, slackImage } from "../src/reviews/media";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe("review media", () => {
  // The host's config dir may have spaces; markdown only ever carries the host path.
  const media = new ReviewMedia(join(mkdtempSync(join(tmpdir(), "relay reviews ")), "media"));

  it("downloads GitHub and Linear images with their auth, `<img>` tags too, and points at the host", async () => {
    const seen: { url: string; auth: string | undefined }[] = [];
    const fetchFn = (url: string, init?: RequestInit): Promise<Response> => {
      seen.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.["authorization"] });
      return Promise.resolve(new Response(PNG, { headers: { "content-type": "image/png" } }));
    };
    const gh = "https://github.com/user-attachments/assets/0e9e";
    const md = `<img width="2900" alt="pair [1440]" src="${gh}" />\n\n![shot one.png](https://uploads.linear.app/a/b?signature=x)\n\n![public](https://example.com/a.png)`;
    const out = await localizeImages(
      md,
      media,
      [
        { match: isGithubUpload, headers: () => Promise.resolve({ authorization: "token T" }) },
        { match: isLinearUpload, headers: () => Promise.resolve({ authorization: "lin" }) },
      ],
      fetchFn,
    );
    const lines = out.split("\n\n");
    expect(lines[0]).toMatch(/^!\[pair 1440\]\(\/reviews\/media\/[0-9a-f]{40}\.png\/[0-9a-f]{32}\)$/);
    expect(lines[1]).toMatch(/^!\[shot one\.png\]\(\/reviews\/media\/[0-9a-f]{40}\.png\/[0-9a-f]{32}\)$/);
    expect(lines[2]).toBe("![public](https://example.com/a.png)");
    expect(seen).toEqual([
      { url: gh, auth: "token T" },
      { url: "https://uploads.linear.app/a/b?signature=x", auth: "lin" },
    ]);
    const [, name, token] = /\/reviews\/media\/([^/]+)\/([^)]+)\)/.exec(lines[0] ?? "") ?? [];
    const blob = media.open(name ?? "", token ?? "");
    expect(blob?.mimeType).toBe("image/png");
    expect(readFileSync(blob?.path ?? "")).toEqual(Buffer.from(PNG));
  });

  it("keeps the URL when a download fails", async () => {
    const out = await localizeImages(
      '<img src="https://github.com/user-attachments/assets/gone">',
      media,
      [{ match: isGithubUpload, headers: () => Promise.resolve({}) }],
      () => Promise.resolve(new Response("no", { status: 404 })),
    );
    expect(out).toBe("![](https://github.com/user-attachments/assets/gone)");
  });

  it("reads Slack files only through files.info, and gives up when Slack's port is closed", async () => {
    const script = slackFetchScript("F0CCWMUPTK7");
    expect(script).toContain("'/api/files.info'");
    expect(script).not.toMatch(/chat\.postMessage|location\s*=|\.click\(|keyboard|dispatchEvent/);
    expect(await slackImage("F1", media, "http://127.0.0.1:9")).toBeNull();
  });
});
