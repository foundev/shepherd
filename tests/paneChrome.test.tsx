import { Box, renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { TerminalPane } from "../src/client/TerminalPane.js";
import { displayWidth, type PaneFrame } from "../src/client/geometry.js";
import { configureTerminalColors } from "../src/client/colors.js";
import { applyTheme, theme } from "../src/client/theme.js";
import type { AgentTask, PaneView } from "../src/types.js";

const pane: PaneView = {
  id: "p1", title: "Editor", cwd: "/work/shepherd", agent: "codex",
  command: null, status: "working", exitCode: null, updatedAt: "",
};

const task: AgentTask = {
  title: "Implement search", summary: "", nextAction: "", blocker: "",
  checkStatus: "unknown", checkSummary: "", review: "none", revision: 1,
  updatedAt: 0, source: "integration", reviewRequestedAt: null, activity: [],
};

function draw(value: PaneView, width = 72, frame?: PaneFrame, label = value.task?.title || value.title) {
  return renderToString(
    <TerminalPane pane={value} focused width={width} height={5} frame={frame}
      label={label} lines={[[{ text: "terminal output" }]]} />,
    { columns: width },
  ).split("\n");
}

function cellAt(text: string, column: number): string | undefined {
  let cursor = 0;
  for (const character of text) {
    if (cursor === column) return character;
    cursor += displayWidth(character);
  }
  return undefined;
}

describe("pane chrome", () => {
  it("retains its neutral title surface inside the application's canvas", () => {
    const restore = configureTerminalColors({ isTTY: true }, { FORCE_COLOR: "3" });
    try {
      applyTheme("shepherd");
      const rows = renderToString(
        <Box backgroundColor={theme.background}>
          <TerminalPane pane={pane} focused width={72} height={5} label="Editor" lines={[]} />
        </Box>,
        { columns: 72 },
      ).split("\n");
      const rgb = [1, 3, 5].map((offset) => Number.parseInt(theme.surfaceRaised.slice(offset, offset + 2), 16));
      const surface = `\x1b[48;2;${rgb.join(";")}m`;
      expect(rows[0]).toContain(surface);
      expect(rows[1]).not.toContain(surface);
    } finally {
      restore();
      applyTheme("shepherd");
    }
  });

  it("shows task context and reports checks separately from agent completion", () => {
    const completed = draw({ ...pane, status: "done", task });
    expect(completed[0]).toContain("codex · Implement search");
    expect(completed[0]).toContain("◇ Review");
    expect(completed[4]).toContain("/work/shepherd");
    expect(completed[4]).not.toContain("passed");
    expect(completed[4]).not.toContain("✓");

    const checked = draw({ ...pane, status: "done", task: { ...task, checkStatus: "passed" } });
    expect(checked[4]).toContain("✓ checks passed");
  });

  it("uses task evidence for attention and review even if the raw status is working", () => {
    const failed = draw({ ...pane, task: { ...task, checkStatus: "failed" } });
    expect(failed[0]).toContain("! Needs you");
    expect(failed[4]).toContain("× checks failed");
    const reviewing = draw({ ...pane, task: { ...task, review: "requested" } });
    expect(reviewing[0]).toContain("◇ Review");
  });

  it("preserves task titles in narrow splits by reducing status and identity first", () => {
    const value: PaneView = { ...pane, displayAgent: "Claude", status: "blocked", task: { ...task, title: "Database migration" } };
    const standard = draw(value, 34)[0];
    expect(standard).toContain("Claude · Database migration");
    expect(standard).toContain("!");
    expect(standard).not.toContain("Needs you");
    const narrow = draw(value, 26)[0];
    expect(narrow).toContain("Database migration");
    expect(narrow).not.toContain("Claude");
  });

  it.each([4, 8, 13, 24, 35, 44, 60, 88])("keeps CJK titles, paths, and body rows inside %i columns", (width) => {
    const rows = draw({ ...pane, cwd: "/work/日本語/検証", task: { ...task, title: "検索の表示を改善する", checkStatus: "running" } }, width);
    expect(rows).toHaveLength(5);
    rows.forEach((row) => expect(displayWidth(row)).toBe(width));
    expect(cellAt(rows[0]!, 0)).toBe("╭");
    expect(cellAt(rows[0]!, width - 1)).toBe("╮");
    expect(cellAt(rows[4]!, 0)).toBe("╰");
    expect(cellAt(rows[4]!, width - 1)).toBe("╯");
  });

  it("preserves shared junctions under title and footer text", () => {
    const width = 64;
    const row = (start: string, junction: number, glyph: string, end: string) =>
      Array.from({ length: width }, (_, index) => ({
        text: index === 0 ? start : index === width - 1 ? end : index === junction ? glyph : "─",
        accent: true,
      }));
    const frame: PaneFrame = {
      top: row("├", 20, "┴", "┤"),
      bottom: row("└", 31, "┬", "┘"),
      left: Array.from({ length: 3 }, () => ({ text: "│", accent: true })),
      right: Array.from({ length: 3 }, () => ({ text: "│", accent: true })),
    };
    const rows = draw({ ...pane, task: { ...task, title: "検索の表示を改善する", checkStatus: "passed" } }, width, frame);
    expect(rows).toHaveLength(5);
    rows.forEach((line) => expect(displayWidth(line)).toBe(width));
    expect(cellAt(rows[0]!, 20)).toBe("┴");
    expect(cellAt(rows[4]!, 31)).toBe("┬");
    expect(rows[0]).toContain("Working");
    expect(rows[4]).toContain("checks passed");
    expect(rows[1]).toContain("│terminal output");
  });

  it("respects hidden labels and missing borders without consuming terminal cells", () => {
    expect(draw(pane, 72, undefined, "")[0]).not.toContain("codex");
    expect(draw({ ...pane, task }, 72, undefined, "Custom pane name")[0]).toContain("Custom pane name");
    const withoutAgent = renderToString(
      <TerminalPane pane={pane} focused width={72} height={5} label="Editor" showAgentLabel={false} lines={[]} />,
      { columns: 72 },
    );
    expect(withoutAgent).toContain("Editor");
    expect(withoutAgent).not.toContain("codex");
    const rows = draw(pane, 24, { top: null, bottom: null, left: null, right: null });
    expect(rows).toHaveLength(5);
    expect(rows[0]?.trimEnd()).toBe("terminal output");
    expect(rows.join("\n")).not.toContain("Working");
    expect(rows.join("\n")).not.toContain("/work/shepherd");
  });
});
