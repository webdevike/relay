import { describe, expect, it } from "vitest";
import type { AgentSkill } from "@relay/protocol";
import { MAX_SLASH_MATCHES, completeSlash, slashMatches } from "./slash";

const handoff: AgentSkill = { name: "handoff", description: "Hand off and compact", command: "/handoff", takesText: true, hint: "[focus instructions]" };
const goal: AgentSkill = {
  name: "goal",
  description: "Goal mode",
  command: "/goal",
  takesText: true,
  choices: [
    { name: "set", description: "Set the goal", command: "/goal set", takesText: true, hint: "<objective>" },
    { name: "show", description: "Show the goal", command: "/goal show", takesText: false },
    { name: "resume", description: "Resume it", command: "/goal resume", takesText: false },
  ],
};
const skills: AgentSkill[] = [
  { name: "review", description: "Review a diff", command: "/skill:review", takesText: true },
  handoff,
  goal,
  { name: "plan", description: "Plan first", command: "/plan", takesText: true },
];

const names = (draft: string) => slashMatches(draft, skills).map((entry) => entry.command);

describe("slashMatches", () => {
  it("lists every command for a bare slash and nothing for plain text", () => {
    expect(names("/")).toEqual(["/skill:review", "/handoff", "/goal", "/plan"]);
    expect(names("hello /goal")).toEqual([]);
    expect(names("")).toEqual([]);
  });

  it("puts prefix matches ahead of names that only contain the text", () => {
    expect(names("/h")).toEqual(["/handoff"]);
    // "pl" prefixes plan; "review" has no "pl"; nothing contains it otherwise.
    expect(names("/pl")).toEqual(["/plan"]);
    // "o" prefixes nothing; goal, handoff contain it.
    expect(names("/o")).toEqual(["/handoff", "/goal"]);
    // An authored skill matches by its name and by its skill: command.
    expect(names("/rev")).toEqual(["/skill:review"]);
    expect(names("/skill:")).toEqual(["/skill:review"]);
    expect(names("/HAND")).toEqual(["/handoff"]);
  });

  it("hides a command typed out in full unless it opens subcommands", () => {
    expect(names("/handoff")).toEqual([]);
    expect(names("/goal")).toEqual(["/goal"]);
  });

  it("lists a command's subcommands after its name and a space, filtered by the next word", () => {
    expect(names("/goal ")).toEqual(["/goal set", "/goal show", "/goal resume"]);
    expect(names("/goal sh")).toEqual(["/goal show"]);
    // "s" prefixes set and show; resume only contains it, so it comes last.
    expect(names("/goal s")).toEqual(["/goal set", "/goal show", "/goal resume"]);
    expect(names("/goal show")).toEqual([]);
    expect(names("/goal set ship it")).toEqual([]);
    expect(names("/handoff ")).toEqual([]);
    expect(names("/unknown ")).toEqual([]);
  });

  it("caps the list", () => {
    const many: AgentSkill[] = Array.from({ length: 20 }, (_, i) => ({ name: `s${i}`, description: "", command: `/s${i}`, takesText: true }));
    expect(slashMatches("/s", many)).toHaveLength(MAX_SLASH_MATCHES);
  });
});

describe("completeSlash", () => {
  it("leaves room for text or subcommands, and none after a complete subcommand", () => {
    expect(completeSlash(handoff)).toBe("/handoff ");
    expect(completeSlash(goal)).toBe("/goal ");
    expect(completeSlash({ name: "show", description: "", command: "/goal show", takesText: false })).toBe("/goal show");
  });
});
