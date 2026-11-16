import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Every link kind Relay desktop's `link` tool builds (plus the rooms tools' room link), with the
 * phone screen it opens. packages/contract checks `params -> url` against the real builder; the
 * phone tests check `url -> phone path` against the phone's table.
 */
export interface LinkKind {
  what: string;
  url: string;
  phone: string;
  notice?: string;
}

const FILE = path.resolve(
  import.meta.dirname,
  "../../../../packages/contract/src/app-link-kinds.fixture.json",
);

// The file is ours and checked by packages/contract/src/agent-access.test.ts; the shape is that test's.
export const LINK_KINDS = (JSON.parse(readFileSync(FILE, "utf8")) as { kinds: LinkKind[] }).kinds;
