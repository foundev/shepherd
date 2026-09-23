import { describe, expect, it } from "vitest";
import { rule, type Manifest } from "../src/server/detection/manifest.js";
import { evaluate, isHorizontalRule, region } from "../src/server/detection/engine.js";
import {
  AgentDetector,
  STARTUP_GRACE_MS,
  HOOK_TTL_MS,
} from "../src/server/detection/detector.js";

const input = (text: string, oscTitle = "", oscProgress = "") => ({
  text,
  oscTitle,
  oscProgress,
});

const SCREEN = [
  "● Wrote the migration",
  "",
  "──────────────────────────────",
  "❯ ",
  "──────────────────────────────",
  "  ? for shortcuts",
  "",
].join("\n");

describe("regions", () => {
  it("finds the prompt box between the last two rules", () => {
    expect(region(input(SCREEN), "prompt_box_body")).toBe("❯ \n");
    expect(region(input(SCREEN), "above_prompt_box")).toBe("● Wrote the migration\n\n");
    expect(region(input(SCREEN), "last_non_empty_above_prompt_box")).toBe("● Wrote the migration");
    expect(region(input(SCREEN), "after_last_horizontal_rule")).toBe("  ? for shortcuts\n");
  });

  it("counts bottom and top lines like Native", () => {
    const text = "a\n\nb\nc\n\n";
    expect(region(input(text), "bottom_lines(2)")).toBe("c\n\n");
    expect(region(input(text), "bottom_non_empty_lines(2)")).toBe("b\nc\n\n");
    expect(region(input(text), "bottom_non_empty_lines(9)")).toBe("a\n\nb\nc\n\n");
    expect(region(input(text), "top_non_empty_lines(2)")).toBe("a\n\nb\n");
  });

  it("tracks Codex-style prompt markers and block markers", () => {
    const text = "• Ran tests\n› fix the bug\n";
    expect(region(input(text), "before_current_prompt_marker")).toBe("• Ran tests\n");
    expect(region(input(text), "current_prompt_block_marker")).toBe("• Ran tests\n");
    expect(region(input(text), "whole_recent_without_current_prompt_marker")).toBe("");
    const answered = "› fix the bug\n• Working\n";
    expect(region(input(answered), "whole_recent_without_current_prompt_marker")).toBe(answered);
  });

  it("recognises horizontal rules, including labelled ones", () => {
    expect(isHorizontalRule("────")).toBe(true);
    expect(isHorizontalRule("─── label ───")).toBe(true);
    expect(isHorizontalRule("── x")).toBe(false);
    expect(isHorizontalRule("text")).toBe(false);
  });
});

const MANIFEST: Manifest = {
  id: "demo",
  rules: [
    rule("prompt_idle", {
      state: "idle",
      priority: 950,
      region: "prompt_box_body",
      visible: true,
      lineRegex: [/^\s*❯/u],
      not: [{ contains: ["enter to select"] }],
    }),
    rule("title_spinner", {
      state: "working",
      priority: 1100,
      region: "osc_title",
      regex: [/^[\u2800-\u28FF] /u],
    }),
    rule("approval", {
      state: "blocked",
      priority: 900,
      region: "bottom_non_empty_lines(6)",
      visible: true,
      any: [
        { contains: ["[y/n]"] },
        { contains: ["do you want to"], any: [{ contains: ["yes"] }] },
      ],
    }),
    rule("transcript", {
      state: "unknown",
      priority: 1000,
      region: "bottom_non_empty_lines(2)",
      skipStateUpdate: true,
      contains: ["showing detailed transcript"],
    }),
  ],
};

describe("rule evaluation", () => {
  it("picks the highest-priority matching rule", () => {
    expect(evaluate(MANIFEST, input(SCREEN)).rule?.id).toBe("prompt_idle");
    expect(evaluate(MANIFEST, input(SCREEN, "⠋ Working")).state).toBe("working");
    const blocked = evaluate(MANIFEST, input("Do you want to apply?\n❯ 1. Yes\n"));
    expect(blocked.state).toBe("blocked");
    expect(blocked.visibleBlocker).toBe(true);
    expect(evaluate(MANIFEST, input("Showing detailed transcript\n")).skipStateUpdate).toBe(true);
  });

  it("keeps an unrecognized screen unknown even for a known agent", () => {
    const result = evaluate(MANIFEST, input("nothing here\n"));
    expect(result.state).toBe("unknown");
    expect(result.fallbackReason).toBe("no_matching_signal");
    expect(evaluate(null, input("Task completed")).state).toBe("unknown");
  });
});

describe("agent detector", () => {
  const read = (text: string) => () => input(text);

  it("waits out the startup grace, then follows the screen", () => {
    const detector = new AgentDetector();
    detector.setAgent("claude", 0);
    expect(detector.status()).toBe("unknown");
    detector.noteOutput();
    expect(detector.tick(1_000, read("Do you want to continue? [y/N]\n"), false)).toBe(false);
    expect(detector.tick(STARTUP_GRACE_MS + 1, read("Do you want to continue? [y/N]\n"), false))
      .toBe(true);
    expect(detector.status()).toBe("blocked");
  });

  it("requires an actual idle signal before publishing an unseen completion", () => {
    const detector = new AgentDetector();
    detector.setAgent("claude", 0);
    let now = STARTUP_GRACE_MS + 1;
    detector.noteOutput();
    detector.tick(now, read("⠋ thinking about it\n"), false);
    expect(detector.status()).toBe("working");

    detector.noteOutput();
    now += 100;
    expect(detector.tick(now, read("all quiet\n"), false)).toBe(true);
    expect(detector.status()).toBe("unknown");
    expect(detector.completionSequence).toBe(0);
    now += 100;
    detector.tick(now, read(SCREEN), false);
    now += 100;
    detector.tick(now, read("all quiet\n"), false);
    expect(detector.status()).toBe("done");

    expect(detector.markSeen()).toBe(true);
    expect(detector.status()).toBe("idle");
  });

  it("does not mark a completion done while the user is watching", () => {
    const detector = new AgentDetector();
    detector.setAgent("claude", 0);
    detector.noteOutput();
    detector.tick(STARTUP_GRACE_MS + 1, read("⠋ thinking\n"), true);
    detector.noteOutput();
    for (let step = 1; step <= 3; step += 1) {
      detector.tick(STARTUP_GRACE_MS + 1 + step * 100, read(SCREEN), true);
    }
    expect(detector.status()).toBe("idle");
  });

  it("reports the exit as a completion, then forgets the agent", () => {
    const detector = new AgentDetector();
    detector.setAgent("claude", 0);
    detector.noteOutput();
    detector.tick(STARTUP_GRACE_MS + 1, read("⠋ thinking\n"), false);
    expect(detector.probe(null, true, 5_000, false)).toBe(true);
    expect(detector.agent).toBe("claude");
    expect(detector.status()).toBe("done");
    expect(detector.probe(null, true, 6_000, false)).toBe(true);
    expect(detector.agent).toBeNull();
    expect(detector.status()).toBe("unknown");
  });

  it("lets a hook report win unless the screen shows a newer blocker", () => {
    const detector = new AgentDetector();
    detector.setAgent("claude", 0);
    detector.reportHook("working", "hook", 5_000, false);
    expect(detector.status()).toBe("working");
    detector.noteOutput();
    detector.tick(6_000, read("Do you want to continue? [y/N]\n"), false);
    expect(detector.status()).toBe("blocked");
  });

  it("expires silent integrations without inventing a completion", () => {
    const detector = new AgentDetector();
    detector.setAgent("claude", 0);
    detector.reportHook("working", "test-hook", 5000, false);
    expect(detector.signal()).toMatchObject({ source: "integration", confidence: "reported", expiresAt: 5000 + HOOK_TTL_MS });
    detector.tick(5000 + HOOK_TTL_MS, read("no recognizable UI"), false);
    expect(detector.status()).toBe("unknown");
    expect(detector.signal().reason).toContain("expired");
    expect(detector.completionSequence).toBe(0);
  });

  it("does not let a stale approval screen override a newer hook", () => {
    const detector = new AgentDetector();
    detector.setAgent("claude", 0);
    detector.tick(4000, read("Do you want to continue? [y/N]"), false);
    detector.reportHook("working", "hook", 5000, false);
    detector.tick(6000, read("Do you want to continue? [y/N]"), false);
    expect(detector.status()).toBe("working");
  });

  it("lets fresh visible work supersede a stale idle report", () => {
    const detector = new AgentDetector();
    detector.setAgent("claude", 0);
    detector.reportHook("idle", "hook", 5000, false);
    detector.noteOutput();
    detector.tick(6000, read("⠋ thinking"), false);
    expect(detector.status()).toBe("working");
    expect(detector.signal().confidence).toBe("inferred");
  });

  it("preserves a live integration lease across unmatched process probes", () => {
    const detector = new AgentDetector();
    detector.setAgent("custom-agent", 0);
    detector.reportHook("blocked", "wrapper", 5000, false);
    for (let i = 0; i < 10; i++) detector.probe(null, i % 2 === 0, 6000 + i * 100, false);
    expect(detector.status()).toBe("blocked");
    detector.exited(8000, false);
    expect(detector.status()).toBe("done");
    expect(detector.signal().source).toBe("process");
  });
});
