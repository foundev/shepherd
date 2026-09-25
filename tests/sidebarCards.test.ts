import { describe, expect, it } from "vitest";
import { sidebarRows, targetAt, type ChromeRow, type SidebarOptions } from "../src/client/chrome.js";
import { displayWidth } from "../src/client/geometry.js";
import { parseSidebarConfig } from "../src/config/sidebar.js";
import { updateTask } from "../src/server/tasks.js";
import type { StateView } from "../src/types.js";

function state(): StateView {
  return {
    protocolVersion: 1, serverPid: 1, session: "test", stateVersion: 1,
    activeWorkspaceId: "w1", activeTabId: "t1", focusedPaneId: "p1", plugins: [], machines: [], tabs: [],
    workspaces: [{ id: "w1", name: "atlas", rootPath: "/work/atlas", activeTabId: "t1",
      tabs: [{ id: "t1", name: "release", layout: { kind: "pane", paneId: "p1" } }] }],
    panes: [{ id: "p1", title: "Claude", terminalTitle: "Old terminal activity", agent: "claude", displayAgent: "Claude",
      command: "claude", cwd: "/work/atlas", status: "working", exitCode: null, updatedAt: "2026-09-25T09:00:00Z",
      task: updateTask(null, { title: "Database migration", blocker: "Approve migration", nextAction: "Run tests" }),
      tokens: { ticket: "ENG-42" } }],
  };
}

const options: SidebarOptions = {
  width: 32, height: 40, focusedPaneId: "p1", activeWorkspaceId: "w1", indicators: "symbols",
  sort: "status", mouse: true, navigateWorkspaceId: null, compact: false,
};
const text = (row: ChromeRow) => row.segments.map((segment) => segment.text).join("");

describe("task-first sidebar cards", () => {
  it("shows reported work and its blocker, with the complete card clickable", () => {
    const rows = sidebarRows(state(), options);
    const card = rows.filter((row) => row.target?.kind === "agent");
    expect(card.map(text).join("\n")).toContain("Database migration");
    expect(card.map(text).join("\n")).toContain("Claude · atlas");
    expect(card.map(text).join("\n")).toContain("Approve migration");
    expect(card.map(text).join("\n")).not.toContain("Old terminal activity");
    expect(card.map(text).join("\n")).not.toContain("Run tests");
    for (const row of card) {
      expect(targetAt(row, 30)).toEqual({ kind: "agent", paneId: "p1" });
      expect(displayWidth(text(row))).toBeLessThanOrEqual(31);
    }
    // Task evidence takes precedence over the process's working state.
    expect(rows.map(text).join("\n")).toContain("NEEDS YOU");
  });

  it("keeps user templates and per-agent overrides literal", () => {
    const sidebar = parseSidebarConfig({ agents: {
      rows: [["pane"]],
      rows_by_agent: { claude: [[{ token: "$ticket", fg: "#abcdef" }], ["agent"]] },
      row_gap: 2,
    } }, []);
    const card = sidebarRows(state(), { ...options, sidebar }).filter((row) => row.target?.kind === "agent");
    expect(card.map((row) => text(row).replace(/^▎?\s*/, ""))).toEqual(["ENG-42", "Claude"]);
    expect(card.flatMap((row) => row.segments).find((segment) => segment.text === "ENG-42")?.color).toBe("#abcdef");
    expect(card.map(text).join("\n")).not.toContain("Database migration");
  });

  it("gives additional terminal height to agents instead of blank navigation", () => {
    const firstAgent = (height: number) => sidebarRows(state(), { ...options, height })
      .findIndex((row) => row.target?.kind === "agent");
    expect(firstAgent(60)).toBe(firstAgent(30));
    expect(firstAgent(60)).toBeLessThan(15);
  });

  it("reveals the focused agent when a short terminal only fits one card row", () => {
    const fleet = state();
    fleet.panes = Array.from({ length: 10 }, (_, index) => ({ ...fleet.panes[0]!, id: `p${index}` }));
    fleet.workspaces = fleet.panes.map((pane, index) => ({
      id: `w${index}`, name: `project-${index}`, rootPath: "/work", activeTabId: `t${index}`,
      tabs: [{ id: `t${index}`, layout: { kind: "pane", paneId: pane.id } }],
    }));
    const rows = sidebarRows(fleet, { ...options, height: 14, focusedPaneId: "p9", activeWorkspaceId: "w9" });
    expect(rows.some((row) => row.target?.kind === "agent" && row.target.paneId === "p9")).toBe(true);
  });

  it.each([[7, 1], [8, 1], [9, 2]] as const)(
    "keeps workspace navigation and the focused agent visible at %i rows",
    (height, capacity) => {
      const fleet = state();
      fleet.panes = Array.from({ length: 3 }, (_, index) => ({ ...fleet.panes[0]!, id: `p${index}` }));
      fleet.workspaces = fleet.panes.map((pane, index) => ({
        id: `w${index}`, name: `project-${index}`, rootPath: "/work", activeTabId: `t${index}`,
        tabs: [{ id: `t${index}`, layout: { kind: "pane", paneId: pane.id } }],
      }));
      for (const mouse of [true, false]) {
        const rows = sidebarRows(fleet, { ...options, height, mouse, focusedPaneId: "p1", activeWorkspaceId: "w1" });
        const navigation = rows.filter((row) => row.target?.kind === "workspace");
        expect(navigation).toHaveLength(capacity);
        expect(navigation.some((row) => row.target?.kind === "workspace" && row.target.id === "w1")).toBe(true);
        expect(rows.some((row) => row.target?.kind === "agent" && row.target.paneId === "p1")).toBe(true);
        expect(rows).toHaveLength(height);
      }
    },
  );

  it("keeps previously visible git workspaces reachable by mouse", () => {
    const fleet = state();
    fleet.panes = Array.from({ length: 7 }, (_, index) => ({ ...fleet.panes[0]!, id: `p${index}` }));
    fleet.workspaces = fleet.panes.map((pane, index) => ({
      id: `w${index}`, name: `project-${index}`, rootPath: `/work/project-${index}`, activeTabId: `t${index}`,
      tabs: [{ id: `t${index}`, layout: { kind: "pane", paneId: pane.id } }],
      git: { repoName: `project-${index}`, repoKey: `project-${index}`, repoRoot: `/work/project-${index}`,
        checkoutPath: `/work/project-${index}`, linked: false, branch: "main", ahead: 0, behind: 0 },
    }));
    const rows = sidebarRows(fleet, { ...options, focusedPaneId: "p0", activeWorkspaceId: "w0" });
    for (const workspace of fleet.workspaces) {
      const row = rows.find((row) => row.target?.kind === "workspace" && row.target.id === workspace.id);
      expect(targetAt(row, 8)).toEqual({ kind: "workspace", id: workspace.id });
    }
  });
});
