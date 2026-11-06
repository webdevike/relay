import { describe, expect, it, vi } from "vitest";
import { AskGate, AskHold, isBackgroundLine } from "../src/agents/ask-hold";

describe("isBackgroundLine", () => {
  it("matches job, agent-session and heartbeat lines for any assistant title", () => {
    expect(isBackgroundLine("[From Nova's background jobs] [agent-session] work finished")).toBe(true);
    expect(isBackgroundLine("[From Eva's background jobs] heartbeat")).toBe(true);
  });
  it("does not match what Isaac types, even when it mentions a job line", () => {
    expect(isBackgroundLine("no, skip it")).toBe(false);
    expect(isBackgroundLine("what was that [From Nova's background jobs] line?")).toBe(false);
    expect(isBackgroundLine("[answer to ask a1] yes")).toBe(false);
  });
});

describe("AskHold", () => {
  it("keeps lines while an ask is open and delivers them in order once it closes", () => {
    const hold = new AskHold();
    const out: string[] = [];
    hold.hold(() => out.push("one"));
    hold.hold(() => out.push("two"));
    hold.release(() => true);
    expect(out).toEqual([]);
    expect(hold.size).toBe(2);
    hold.release(() => false);
    expect(out).toEqual(["one", "two"]);
    expect(hold.size).toBe(0);
  });
  it("delivers nothing after clear", () => {
    const hold = new AskHold();
    const deliver = vi.fn();
    hold.hold(deliver);
    hold.clear();
    hold.release(() => false);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("AskGate", () => {
  const setup = () => {
    let open = true;
    const cancel = vi.fn(() => {
      open = false;
    });
    const gate = new AskGate({ open: () => open, cancel }, 5);
    return { gate, cancel, answer: () => (open = false), reopen: () => (open = true) };
  };
  const JOB = "[From Nova's background jobs] [agent-session] review finished";

  it("holds a background line, leaves the ask open, and delivers after the answer", async () => {
    vi.useFakeTimers();
    try {
      const { gate, cancel, answer } = setup();
      const delivered = vi.fn();
      expect(await gate.admit(JOB, true, delivered)).toBe(false);
      expect(cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(50);
      expect(delivered).not.toHaveBeenCalled();
      answer();
      gate.closed();
      await vi.advanceTimersByTimeAsync(50);
      expect(delivered).toHaveBeenCalledTimes(1);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps holding when another ask opens before the line is released", async () => {
    vi.useFakeTimers();
    try {
      const { gate, answer, reopen } = setup();
      const delivered = vi.fn();
      await gate.admit(JOB, true, delivered);
      answer();
      gate.closed();
      reopen();
      await vi.advanceTimersByTimeAsync(50);
      expect(delivered).not.toHaveBeenCalled();
      expect(gate.waiting).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the ask for Isaac's own typed turn, then lets it through", async () => {
    vi.useFakeTimers();
    try {
      const { gate, cancel } = setup();
      const pending = gate.admit("no, do it differently", true, vi.fn());
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes everything straight through when no ask is open, and never cancels for editor-only text", async () => {
    const { gate, cancel, answer } = setup();
    expect(await gate.admit("draft", false, vi.fn())).toBe(true);
    expect(await gate.admit(JOB, false, vi.fn())).toBe(true);
    answer();
    expect(await gate.admit(JOB, true, vi.fn())).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
  });
});
