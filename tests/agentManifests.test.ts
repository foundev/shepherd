import { describe, expect, it } from "vitest";
import {
  AGENTS,
  detectAgentFromCommand,
  manifestFor,
} from "../src/server/detection/agents.js";
import { evaluate } from "../src/server/detection/engine.js";

function screenState(agent: string, text: string, oscTitle = "", oscProgress = "") {
  return evaluate(manifestFor(agent), { text: `${text}\n`, oscTitle, oscProgress }).state;
}

describe("built-in agent definitions", () => {
  it("covers the agent roster", () => {
    expect(AGENTS.map((agent) => agent.id).sort()).toEqual([
      "aider",
      "amp",
      "antigravity",
      "claude",
      "cline",
      "codex",
      "copilot",
      "cursor",
      "devin",
      "droid",
      "gemini",
      "grok",
      "hermes",
      "kilo",
      "kimi",
      "kiro",
      "letta",
      "maki",
      "muse",
      "opencode",
      "pi",
      "qodercli",
      "qwen",
    ]);
  });

  it("recognises agents and their aliases from command lines", () => {
    expect(detectAgentFromCommand("/usr/local/bin/claude --help")).toBe("claude");
    expect(detectAgentFromCommand("claude-code")).toBe("claude");
    expect(detectAgentFromCommand("cursor-agent --resume x")).toBe("cursor");
    expect(detectAgentFromCommand("agy")).toBe("antigravity");
    expect(detectAgentFromCommand("opencode")).toBe("opencode");
    expect(detectAgentFromCommand("/home/user/.local/bin/muse-bin-1.4.0-R4161.1 --workspace /tmp/project")).toBe("muse");
    expect(detectAgentFromCommand("muse resume session-123")).toBe("muse");
    expect(detectAgentFromCommand("muse-bin-unrelated")).toBeNull();
    expect(detectAgentFromCommand("npm run build")).toBeNull();
    expect(detectAgentFromCommand("piper")).toBeNull();
  });

  it.each([
    ["claude", "Claude wants to edit src/app.ts\n\nDo you want to proceed? (y/n)", "blocked"],
    ["claude", "Claude has finished editing src/app.ts.", "unknown"],
    ["claude", "Edit src/app.ts?\n❯ 1. Yes\n  2. No", "blocked"],
    ["claude", "✻ Pondering… (12s · esc to interrupt)\n──────\n> \n──────", "working"],
    ["claude", "● Done.\n──────────\n> \n──────────\n  ? for shortcuts", "idle"],
    ["codex", "Codex proposes a shell command.\n\nApprove command? [y/N]", "blocked"],
    ["codex", "working: summarizing repository", "working"],
    ["codex", "Codex has finished summarizing the repository.", "unknown"],
    ["codex", "• Ran tests\n\n› ", "idle"],
    ["gemini", "Approve this command?\n[1] Yes [2] No", "blocked"],
    ["opencode", "Approve session update before continuing? [y/N]", "blocked"],
    ["aider", "⠋ Thinking about it", "working"],
    ["muse", "Muse Code 1.4.0\n──────\n❯ \n──────\n  echo · /tmp/project · Auto-review", "idle"],
    ["muse", "⠋ Thinking (esc to interrupt)\n──────\n❯ \n──────", "working"],
    ["muse", "Allow this command? [y/N]\n──────\n❯ \n──────", "blocked"],
    ["muse", "The response is finished.", "unknown"],
    ["muse", "──────\n❯ unsubmitted draft\n──────", "unknown"],
  ])("%s: %j is %s", (agent, screen, expected) => {
    expect(screenState(agent, screen)).toBe(expected);
  });

  it("reads terminal title spinners and progress reports", () => {
    expect(screenState("claude", "", "⠙ Refactoring")).toBe("working");
    expect(screenState("pi", "", "", "4;3;")).toBe("working");
    expect(screenState("pi", "", "", "4;0;")).toBe("idle");
  });
});
