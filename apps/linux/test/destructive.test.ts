import { describe, expect, it } from "vitest";
import { destructivePattern } from "../src/agents/destructive";

describe("destructivePattern", () => {
  // Same table as `destructive_patterns` in apps/evaos/src/inbox.rs.
  const table: [string, string | null][] = [
    ["git push --force origin main", "force push"],
    ["git push -f", "force push"],
    ["git push --force-with-lease origin style/ENG-6243", "force push"],
    ["cd x && git push --force-with-lease=main", "force push"],
    ["rm -rf node_modules", "rm -rf"],
    ["rm -fr build", "rm -rf"],
    ["sudo rm -Rf /tmp/x", "rm -rf"],
    ["wrangler deploy", "deploy"],
    ["bun run deploy", "deploy"],
    ["cp a.txt /srv/prod/config.json", "prod write"],
    ["git push origin main", null],
    ["rm file.txt", null],
    ["rm -r dir", null],
    ["ls -la", null],
    ["git status", null],
  ];
  for (const [command, kind] of table) {
    it(`${command} -> ${kind ?? "ordinary"}`, () => {
      expect(destructivePattern(command)).toBe(kind);
    });
  }
});
