// The tool calls that must never be approved on a tap alone: a phone asks for Face ID first and
// never offers "always allow". Force push, `rm -rf`, deploys, and writes under prod paths.
//
// This is the same list, with the same behaviour, as `destructive()` in EvaOS's inbox
// (apps/evaos/src/inbox.rs); change them together. The test table in test/destructive.test.ts
// is the table in that file's `destructive_patterns` test.

/** Characters that separate words besides whitespace: shell operators and quotes. */
const SEPARATORS = /[\s;&|()"']+/u;

/** The name of the destructive pattern `command` matches, or null for an ordinary call. */
export function destructivePattern(command: string): string | null {
  const text = command.toLowerCase();
  const words = text.split(SEPARATORS).filter((word) => word.length > 0);
  const has = (flag: string): boolean => words.includes(flag);

  if (text.includes("git push") && (has("-f") || has("--force") || has("--force-with-lease") || words.some((word) => word.startsWith("--force-with-lease=")))) {
    return "force push";
  }
  if (
    words.includes("rm") &&
    words.some((word) => {
      if (!word.startsWith("-")) return false;
      const flags = word.slice(1);
      return !flags.startsWith("-") && flags.includes("r") && flags.includes("f");
    })
  ) {
    return "rm -rf";
  }
  if (words.some((word) => word === "deploy" || word.endsWith(":deploy"))) return "deploy";
  if (words.some((word) => word.split("/").some((part) => part === "prod" || part === "production"))) return "prod write";
  return null;
}
