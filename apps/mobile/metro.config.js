// Monorepo-aware Metro: watch the workspace root so @relay/protocol resolves from source.
const { getDefaultConfig } = require("expo/metro-config");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

/**
 * React and every dependency with native code must be bundled once. A checkout whose install mixes
 * pnpm layouts (a hoisted root next to a leftover isolated `node_modules/.pnpm`) resolves them from
 * two places, and the bundle then carries two Reanimated/Worklets copies that initialize the same
 * native module twice: Hermes heap corruption and a crash at launch (the 2026-11-10 phone OTAs).
 * So the build fails instead, naming both copies.
 */
function nativeBacked(name) {
  try {
    const dir = path.dirname(require.resolve(`${name}/package.json`, { paths: [projectRoot] }));
    return (
      ["ios", "apple", "expo-module.config.json"].some((entry) => fs.existsSync(path.join(dir, entry))) ||
      fs.readdirSync(dir).some((entry) => entry.endsWith(".podspec"))
    );
  } catch {
    return false;
  }
}
const pkg = require("./package.json");
const singletons = new Set(["react", ...Object.keys(pkg.dependencies ?? {}).filter(nativeBacked)]);
const copies = new Map();

function packageOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const upstreamResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolution = (upstreamResolve ?? context.resolveRequest)(context, moduleName, platform);
  const name = packageOf(moduleName);
  if (resolution.type === "sourceFile" && singletons.has(name)) {
    const marker = `${path.sep}node_modules${path.sep}${name}${path.sep}`;
    const at = resolution.filePath.lastIndexOf(marker);
    if (at !== -1) {
      const root = fs.realpathSync(resolution.filePath.slice(0, at + marker.length));
      const seen = copies.get(name);
      if (seen === undefined) copies.set(name, root);
      else if (seen !== root) {
        throw new Error(
          `Two copies of ${name} in the bundle (${seen} and ${root}). A native package bundled twice crashes the app at launch: reinstall node_modules (rm -rf node_modules apps/*/node_modules packages/*/node_modules, then pnpm install).`,
        );
      }
    }
  }
  return resolution;
};

module.exports = config;
