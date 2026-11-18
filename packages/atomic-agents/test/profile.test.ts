import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Ref } from "effect";
import { readdirSync, readFileSync } from "node:fs";
import { DEFAULT_PROFILE, plistProfile, profileRefusals } from "../src/core/InstallGate.ts";
import { type GenerateRequest, ModelRunner } from "../src/core/Model.ts";
import { Runner } from "../src/core/Runtime.ts";
import { runtime, tempHome } from "./harness.ts";

const plist = (profile?: string) => `<dict>
\t<key>HOME</key><string>/Users/x</string>
${profile === undefined ? "" : `\t<key>OMP_PROFILE</key><string>${profile}</string>\n`}</dict>`;

describe("service profile gate", () => {
  test("an install without --profile is personal, whatever shell it runs in", () => {
    expect(DEFAULT_PROFILE).toBe("personal");
  });

  test("the installed plist's profile is read back; none set or no plist is undefined", () => {
    expect(plistProfile(plist("personal"))).toBe("personal");
    expect(plistProfile(plist())).toBeUndefined();
    expect(plistProfile(undefined)).toBeUndefined();
  });

  test("replacing a service whose plist has another profile is refused with both profiles named", () => {
    const [reason] = profileRefusals({ exists: true, profile: "work" }, "personal");
    expect(reason).toContain("OMP_PROFILE=work");
    expect(reason).toContain("OMP_PROFILE=personal");
    expect(reason).toContain("--force");
    expect(profileRefusals({ exists: true, profile: undefined }, "personal")[0]).toContain(
      "(unset)",
    );
  });

  test("the same profile, or a first install, passes", () => {
    expect(profileRefusals({ exists: true, profile: "personal" }, "personal")).toEqual([]);
    expect(profileRefusals({ exists: false, profile: undefined }, "work")).toEqual([]);
  });
});

const greeter = (profile?: string) =>
  JSON.stringify({
    id: "greeter",
    purpose: "Greet whoever is named.",
    agent: {
      model: "test/m",
      candidates: ["test/m"],
      system: "You greet people.",
      ...(profile === undefined ? {} : { profile }),
    },
    events: {
      "greet.requested": { requestId: "nonEmptyString", name: "string" },
      "greet.ready": { requestId: "string", greeting: "string" },
    },
    job: {
      id: "greet",
      description: "Greet the name.",
      input: "greet.requested",
      triggers: ["manual"],
      prompt: "{{name}}",
      answer: { greeting: "string" },
      output: "greet.ready",
    },
  });

describe("per-agent profile", () => {
  /** The requests an agent file's runs send to the model runner. */
  const requests = (file: string) =>
    Effect.gen(function* () {
      const root = yield* tempHome;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${root}/agents`);
      yield* fs.writeFileString(`${root}/agents/greeter.json`, file);
      const seen = yield* Ref.make<ReadonlyArray<GenerateRequest>>([]);
      const models = ModelRunner.of({
        generate: (request) =>
          Ref.update(seen, (all) => [...all, request]).pipe(
            Effect.as({
              text: JSON.stringify({ answer: { greeting: "hi" } }),
              model: request.model,
              provider: "test",
              seconds: 0,
              cost: 0,
            }),
          ),
      });
      yield* Effect.gen(function* () {
        yield* (yield* Runner).run("greeter", "greet", { requestId: "r1", name: "Ada" });
      }).pipe(Effect.provide(runtime(root, { dirs: [`${root}/agents`] }, models)));
      return yield* Ref.get(seen);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

  test("an agent's profile rides on every model call it makes; without one the call carries none and inherits the service's", async () => {
    const own = await Effect.runPromise(requests(greeter("work")));
    expect(own.map((request) => request.profile)).toEqual(["work"]);
    const inherits = await Effect.runPromise(requests(greeter()));
    expect(inherits).toHaveLength(1);
    expect(inherits[0]!.profile).toBeUndefined();
  });

  test("every ecard agent that calls a model runs on the work profile; the fetchers and watchers (no model) set none", () => {
    const dir = new URL("../domains/ecard/", import.meta.url).pathname;
    const agents = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map(
        (name) =>
          JSON.parse(readFileSync(`${dir}${name}`, "utf8")) as {
            id: string;
            kind?: string;
            agent?: { profile?: string };
          },
      );
    expect(agents.length).toBeGreaterThan(0);
    for (const spec of agents)
      expect([spec.id, spec.kind === "code" ? undefined : spec.agent?.profile]).toEqual([
        spec.id,
        spec.kind === "code" ? undefined : "work",
      ]);
  });
});
