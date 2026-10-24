import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { serverConfig } from "./config";
import { buildManifest, platformDir, type UpdateRef } from "./updates";

/**
 * Publishes the current apps/mobile tree as an iOS update: `expo export` into a staging directory
 * in the data dir, the public expo config beside it, then a rename that makes it the newest update
 * for its runtime. The running server picks it up on the next request.
 *
 *   pnpm ota:publish        (repo root)
 */
const mobileDir = path.resolve(import.meta.dirname, "../../mobile");
const platform = "ios";
const config = serverConfig();

const env = { ...process.env };
// Expo CLI behaves differently under CI (agent shells export it); publish as from a terminal.
Reflect.deleteProperty(env, "CI");

interface AppJson {
  expo: { version?: string; runtimeVersion?: string | { policy?: string } };
}

const app = (JSON.parse(await readFile(path.join(mobileDir, "app.json"), "utf8")) as AppJson).expo;
const runtimeVersion =
  typeof app.runtimeVersion === "string"
    ? app.runtimeVersion
    : app.runtimeVersion?.policy === "appVersion"
      ? app.version
      : undefined;
if (runtimeVersion === undefined) {
  throw new Error("app.json needs a string runtimeVersion or the appVersion policy with expo.version");
}

const stamp = String(Date.now());
const parent = platformDir(config.dataRoot, runtimeVersion, platform);
const staging = path.join(parent, `.staging-${stamp}`);
await mkdir(parent, { recursive: true });

try {
  execFileSync("npx", ["expo", "export", "--platform", platform, "--output-dir", staging], {
    cwd: mobileDir,
    env,
    stdio: "inherit",
  });
  const expoConfig = execFileSync("npx", ["expo", "config", "--json", "--type", "public"], {
    cwd: mobileDir,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  await writeFile(path.join(staging, "expoConfig.json"), JSON.stringify(JSON.parse(expoConfig)));
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  throw error;
}

const dir = path.join(parent, stamp);
await rename(staging, dir);
const update: UpdateRef = { runtimeVersion, platform, stamp, dir };
const manifest = await buildManifest(update, config.publicUrl);

console.log(`\nPublished update ${manifest.id}`);
console.log(`  runtime   ${runtimeVersion} (${platform})`);
console.log(`  created   ${manifest.createdAt}`);
console.log(`  files     ${dir}`);
console.log(`  manifest  ${config.publicUrl}/api/manifest?platform=${platform}&runtime-version=${runtimeVersion}`);
console.log(`  bundle    ${manifest.launchAsset.url}`);
