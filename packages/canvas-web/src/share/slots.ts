// Markers in generated/share.html that the Relay host replaces on every load (build.ts writes them,
// apps/linux/src/boards/share-page.ts fills them).

/** Where the page's `SharedBoard` JSON goes (inside `<script id="relay-share" type="application/json">`). */
export const SHARE_DATA_SLOT = "<!--relay-share-data-->";

/** Where the Mantine runtime's `<style>` and `<script>` go, before the page's own script runs. */
export const SHARE_RUNTIME_SLOT = "<!--relay-share-runtime-->";
