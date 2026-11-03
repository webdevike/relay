import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** `CFBundleShortVersionString` of an Info.plist's text, or null. */
export function plistVersion(plist: string): string | null {
  return (
    /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim() ||
    null
  );
}

/**
 * The version of the "Relay Host.app" this binary ships in (`Contents/MacOS/relay-host` next to
 * `Contents/Info.plist`), which is the version installs and updates go by; null outside a bundle,
 * where package.json's version stands.
 */
export function bundleVersion(execPath = process.execPath): string | null {
  try {
    return plistVersion(readFileSync(join(dirname(execPath), "..", "Info.plist"), "utf8"));
  } catch {
    return null;
  }
}
