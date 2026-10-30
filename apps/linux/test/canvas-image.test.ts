import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localImageResponse } from "../src/canvas/http";

function get(file: string, ifNoneMatch?: string): Request {
  const headers: Record<string, string> = {};
  if (ifNoneMatch !== undefined) headers["if-none-match"] = ifNoneMatch;
  return new Request(`http://localhost/canvas/x/img?src=${encodeURIComponent(file)}`, { headers });
}

describe("localImageResponse", () => {
  it("revalidates an overwritten file so it shows the new content", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "canvas-img-")), "a.png");
    writeFileSync(file, "old-bytes");
    utimesSync(file, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));

    const first = localImageResponse(get(file), file, "image/png");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-cache");
    const oldEtag = first.headers.get("etag");
    expect(oldEtag).toBeTruthy();
    expect(await first.text()).toBe("old-bytes");

    // Same path, same size, new mtime: the old ETag no longer matches, so the new bytes come back.
    writeFileSync(file, "new-bytes");
    utimesSync(file, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
    const changed = localImageResponse(get(file, oldEtag ?? undefined), file, "image/png");
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(oldEtag);
    expect(await changed.text()).toBe("new-bytes");
  });

  it("answers 304 while the file is unchanged", () => {
    const file = join(mkdtempSync(join(tmpdir(), "canvas-img-")), "b.png");
    writeFileSync(file, "same");
    const etag = localImageResponse(get(file), file, "image/png").headers.get("etag");
    const again = localImageResponse(get(file, etag ?? undefined), file, "image/png");
    expect(again.status).toBe(304);
  });

  it("reports a missing file as 404", () => {
    const file = join(tmpdir(), "canvas-img-does-not-exist.png");
    expect(localImageResponse(get(file), file, "image/png").status).toBe(404);
  });
});
