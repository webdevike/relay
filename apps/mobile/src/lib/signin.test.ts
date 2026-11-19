import { describe, expect, it } from "vitest";
import { agentHealth, providerName, signinCommand, signinGuidance, signinSetupId } from "./signin";

describe("signin words", () => {
  it("maps omp providers to Relay's setup ids and names", () => {
    expect(signinSetupId("anthropic")).toBe("anthropic");
    expect(signinSetupId("openai-codex")).toBe("openai");
    expect(signinSetupId("groq")).toBeNull();
    expect(providerName("anthropic")).toBe("Claude");
    expect(providerName("openai-codex")).toBe("ChatGPT");
    expect(providerName("groq")).toBe("groq");
  });

  it("builds the login command with or without a profile", () => {
    expect(signinCommand({ kind: "signin", provider: "anthropic", profile: "personal" })).toBe("omp --profile personal login anthropic");
    expect(signinCommand({ kind: "signin", provider: "openai-codex" })).toBe("omp login openai-codex");
  });

  it("says where to sign in again", () => {
    expect(signinGuidance({ kind: "signin", provider: "anthropic", profile: "personal" })).toBe(
      "Sign in again on your Mac: Relay > Settings > Connections > Claude (personal profile)",
    );
    expect(signinGuidance({ kind: "signin", provider: "openai-codex" })).toBe("Sign in again on your Mac: Relay > Settings > Connections > ChatGPT");
    expect(signinGuidance({ kind: "signin", provider: "groq" })).toBe("Sign in again on your Mac: a terminal");
  });
});

describe("agentHealth", () => {
  const at = 1;
  it("is null when signed in with no failure, or from an older host", () => {
    expect(agentHealth({})).toBeNull();
    expect(agentHealth({ auth: { provider: "anthropic", state: "ok" } })).toBeNull();
  });

  it("flags signed out, missing and shared sign-ins with the host's sentence", () => {
    expect(agentHealth({ auth: { provider: "anthropic", state: "signed_out", detail: "Refresh token expired." } })).toEqual({
      label: "Signed out",
      tone: "danger",
      detail: "Refresh token expired.",
    });
    expect(agentHealth({ auth: { provider: "anthropic", state: "missing" } })).toEqual({ label: "Signed out", tone: "danger" });
    expect(agentHealth({ auth: { provider: "anthropic", state: "shared", detail: "Same as default." } })).toEqual({
      label: "Sign-in shared",
      tone: "warn",
      detail: "Same as default.",
    });
  });

  it("flags a failed turn, and a broken sign-in wins over it", () => {
    const failure = { at, kind: "model" as const, title: "Nova couldn't reply", text: "Rate limited." };
    expect(agentHealth({ failure })).toEqual({ label: "Turn failed", tone: "danger", detail: "Rate limited." });
    expect(agentHealth({ failure, auth: { provider: "anthropic", state: "signed_out" } })?.label).toBe("Signed out");
  });
});
