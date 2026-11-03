import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { portrait } from "../../desktop/src/renderer/ui/portrait";
import { loadRegistry } from "../src/assistant/registry";
import { assistantAvatar } from "../src/canvas/portrait";

const HOME = join(homedir(), "Eva");
const live = existsSync(join(HOME, ".omp", "assistant", "agents.json"));

/** What an <img> of Relay desktop's AgentPortrait decodes to. */
const desktopSvg = (data: string): string => decodeURIComponent(data.replace(/^data:image\/svg\+xml;charset=utf-8,/, ""));

describe("canvas avatars match Relay desktop's", () => {
  it.skipIf(!live)("draws nova, astra and polaris from agents.json exactly as the desktop AgentPortrait does", () => {
    const registry = loadRegistry(HOME);
    for (const id of ["nova", "astra", "polaris"]) {
      const agent = registry.find((entry) => entry.id === id);
      expect(agent?.portrait, id).toBeDefined();
      const hostSvg = assistantAvatar(registry, id);
      expect(hostSvg, id).not.toBeNull();
      expect(desktopSvg(portrait(agent?.portrait ?? id)), id).toBe(hostSvg);
      // Micah on the assistant's paper, not the old notionists face.
      expect(hostSvg, id).toContain(agent?.portrait?.colors?.paper?.slice(1) ?? "");
    }
  });

  it("draws a registry portrait and a seed-only agent by the desktop's rules, and nothing for an unknown id", () => {
    const nova = { id: "nova", title: "Nova", avatar: "nova-17", portrait: { style: "micah" as const, seed: "nova-17", colors: { paper: "#e7f5ff" } } };
    const astra = { id: "astra", title: "Astra", avatar: "astra-2" };
    const registry = [nova, astra];
    expect(desktopSvg(portrait(nova.portrait))).toBe(assistantAvatar(registry, "nova"));
    expect(desktopSvg(portrait("astra-2"))).toBe(assistantAvatar(registry, "astra"));
    expect(assistantAvatar(registry, "ghost")).toBeNull();
  });
});
