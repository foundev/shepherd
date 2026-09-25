import React from "react";
import { stripVTControlCharacters } from "node:util";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { workspaceFooterRow, workspaceHeaderRows, WorkspaceHeader } from "../src/client/WorkspaceHeader.js";
import { targetAt, type ChromeRow } from "../src/client/chrome.js";
import { displayWidth } from "../src/client/geometry.js";
import type { AgentStatus, StateView } from "../src/types.js";

const rowText = (row: ChromeRow): string => row.segments.map((segment) => segment.text).join("");

function fixture(): StateView {
  const panes = (["blocked", "working", "working", "done"] as AgentStatus[]).map((status, index) => ({
    id: `pane-${index}`, title: `Agent ${index}`, agent: "codex", command: "codex", cwd: "/work/atlas",
    status, exitCode: null, updatedAt: "2026-09-25T10:00:00.000Z",
  }));
  const tabs = panes.map((pane, index) => ({ id: `tab-${index}`, name: `Task ${index}`, layout: { kind: "pane" as const, paneId: pane.id } }));
  return {
    protocolVersion: 1, session: "development", serverPid: 1, tabs,
    workspaces: [{ id: "atlas", name: "Atlas", rootPath: "/work/atlas", tabs, activeTabId: tabs[0]!.id,
      git: { repoName: "atlas", repoKey: "atlas", repoRoot: "/work/atlas", linked: false, checkoutPath: "/work/atlas", branch: "main", ahead: 0, behind: 0 } }],
    activeWorkspaceId: "atlas", activeTabId: tabs[0]!.id, focusedPaneId: panes[0]!.id,
    panes, plugins: [], machines: [], stateVersion: 1,
  };
}

describe("workspace header geometry and interaction", () => {
  it("renders the live status overview and preserves clickable title and metrics", () => {
    const state = fixture();
    const rows = workspaceHeaderRows(state, 120);
    const title = rowText(rows[1]!);
    expect(title).toContain("Atlas  /  main");
    expect(title).toContain("1 needs you   1 review   2 working");
    expect(targetAt(rows[1], title.indexOf("Atlas"))).toEqual({ kind: "workspace", id: "atlas" });
    expect(targetAt(rows[1], title.indexOf("needs you"))).toEqual({ kind: "agent-sort" });
    expect(rowText(rows[2]!)).toContain("4 agents across your workspaces");
    const frame = stripVTControlCharacters(renderToString(<WorkspaceHeader state={state} width={120} />, { columns: 120 }));
    expect(frame.split("\n")).toHaveLength(3);
    expect(frame).toContain("Atlas  /  main");
  });

  it("reserves urgent counts when long or wide workspace titles compete for space", () => {
    const state = fixture();
    state.workspaces[0]!.name = "研究 " + "an exceptionally long workspace ".repeat(5);
    for (const width of [0, 1, 3, 24, 46, 65, 80, 120]) {
      for (const height of [0, 1, 2, 3]) {
        const rows = workspaceHeaderRows(state, width, height);
        expect(rows).toHaveLength(height);
        for (const row of rows) expect(displayWidth(rowText(row))).toBe(width);
        if (height && width >= 46) expect(rows.map(rowText).join("\n")).toContain("1 needs you");
      }
    }
  });

  it("uses task-aware attention counts and does not count shell panes as agents", () => {
    const state = fixture();
    state.panes.push({ ...state.panes[0]!, id: "shell", agent: null, command: null, status: "idle" });
    state.panes[1]!.task = { blocker: "Needs credentials" } as NonNullable<typeof state.panes[1]["task"]>;
    const title = rowText(workspaceHeaderRows(state, 120)[1]!);
    expect(title).toContain("2 needs you");
    expect(title).toContain("1 working");
    expect(title).not.toContain("ready");
  });

  it("keeps configured shortcuts whole and matches their visible click targets", () => {
    const hints = [{ key: "t", label: "new tab", target: { kind: "new-tab" as const } }, { key: "a", label: "agents", target: { kind: "agent-sort" as const } }];
    const row = workspaceFooterRow({ width: 90, prefix: "ctrl+a", hints, session: "development" });
    const text = rowText(row);
    expect(text).toContain("ctrl+a commands   t new tab   a agents");
    expect(targetAt(row, text.indexOf("ctrl+a"))).toEqual({ kind: "menu" });
    expect(targetAt(row, text.indexOf("new tab"))).toEqual({ kind: "new-tab" });
    const narrow = rowText(workspaceFooterRow({ width: 26, prefix: "ctrl+a", hints }));
    expect(narrow).toContain("ctrl+a commands");
    expect(narrow).not.toContain("new");
    expect(displayWidth(narrow)).toBe(26);
  });
});
