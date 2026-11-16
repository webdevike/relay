// The shared board page, built by packages/canvas-web (`bun run build` -> generated/share.html, one
// self-contained file with slots share-page.ts fills). A text import, so `bun build --compile`
// embeds it in relay-host. Only main.ts imports this module: tests hand the HTTP layer a page of their own.

import html from "../../../../packages/canvas-web/generated/share.html" with { type: "text" };

/** bun-types declares `*.html` as an HTMLBundle (for Bun.serve routes); imported `type: "text"` it is the file's text. */
export const SHARE_PAGE: string = html as unknown as string;
