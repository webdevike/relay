// The canvas web client, built by packages/canvas-web (`bun run build` -> generated/canvas.html,
// one self-contained file). A text import, so `bun build --compile` embeds it in relay-host.
// Only main.ts imports this module: tests hand the HTTP layer a page of their own.

import html from "../../../../packages/canvas-web/generated/canvas.html" with { type: "text" };

/** bun-types declares `*.html` as an HTMLBundle (for Bun.serve routes); imported `type: "text"` it is the file's text. */
export const CANVAS_PAGE: string = html as unknown as string;
