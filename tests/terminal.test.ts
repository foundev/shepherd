import { describe, expect, it } from "vitest";
import {
  detectAgent,
  unwrapTerminalLines,
} from "../src/server/terminal.js";
import { manifestFor } from "../src/server/detection/agents.js";
import { evaluate } from "../src/server/detection/engine.js";

describe("terminal heuristics", () => {
  it("recognizes common coding agents", () => {
    expect(detectAgent("claude --dangerously-skip-permissions")).toBe("claude");
    expect(detectAgent("/usr/local/bin/codex")).toBe("codex");
    expect(detectAgent("npm run build")).toBeNull();
  });

  it("recognizes blocked prompts", () => {
    expect(evaluate(manifestFor("claude"), {
      text: "Do you want to continue? [y/N]\n",
      oscTitle: "",
      oscProgress: "",
    }).state).toBe("blocked");
  });

  it("joins soft-wrapped terminal lines", () => {
    expect(unwrapTerminalLines([
      [{ text: "shep" }],
      [{ text: "herd" }],
      [{ text: "ready" }],
    ], [false, true, false])).toEqual([
      [{ text: "shepherd" }],
      [{ text: "ready" }],
    ]);
  });
});
