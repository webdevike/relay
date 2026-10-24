import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serverConfig } from "./config";

/**
 * Compiles the server to ~/.local/bin/relay-ota (a stable path outside any worktree) and
 * (re)loads the LaunchAgent that keeps it running on 127.0.0.1. Run after changing the server:
 *
 *   pnpm ota:install        (repo root)
 *
 * The phone reaches it through a tailnet-only Tailscale serve entry, set up once:
 *
 *   /Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=8447 http://127.0.0.1:8477
 */
const label = "com.ike.relay-ota";
const home = os.homedir();
const binary = path.join(home, ".local", "bin", "relay-ota");
const plistPath = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
const logPath = path.join(home, "Library", "Logs", "relay-ota.log");
const config = serverConfig();

const xml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

await mkdir(path.dirname(binary), { recursive: true });
await mkdir(config.dataRoot, { recursive: true });
execFileSync("bun", ["build", "--compile", path.join(import.meta.dirname, "main.ts"), "--outfile", binary], {
  stdio: "inherit",
});

const environment = {
  RELAY_OTA_DATA: config.dataRoot,
  RELAY_OTA_PORT: String(config.port),
  RELAY_OTA_PUBLIC_URL: config.publicUrl,
};
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(binary)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(environment)
  .map(([key, value]) => `    <key>${key}</key>\n    <string>${xml(value)}</string>`)
  .join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
await writeFile(plistPath, plist);

const domain = `gui/${String(os.userInfo().uid)}`;
// Not loaded yet on first install; that failure is expected.
spawnSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" });
// bootout returns before the old job is gone; bootstrap fails with EIO until it is.
let loaded = false;
for (let attempt = 0; attempt < 20 && !loaded; attempt++) {
  loaded = spawnSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "ignore" }).status === 0;
  if (!loaded) await Bun.sleep(250);
}
if (!loaded) throw new Error(`launchctl bootstrap ${domain} ${plistPath} kept failing`);

const healthUrl = `http://127.0.0.1:${String(config.port)}/health`;
for (let attempt = 0; attempt < 40; attempt++) {
  const ok = await fetch(healthUrl).then(
    (response) => response.ok,
    () => false,
  );
  if (ok) {
    console.log(`${label} running: ${binary} on ${healthUrl.replace("/health", "")}, log ${logPath}`);
    process.exit(0);
  }
  await Bun.sleep(250);
}
throw new Error(`${label} loaded but ${healthUrl} never answered; see ${logPath}`);
