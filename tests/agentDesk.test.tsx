import { describe, expect, it } from "vitest";
import { deskEntries } from "../src/agentDesk.js";
import { agentEntries, normalizeAgentSort, sidebarRows, type SidebarOptions } from "../src/client/chrome.js";
import { displayWidth } from "../src/client/geometry.js";
import { parseConfig } from "../src/config/model.js";
import { updateTask } from "../src/server/tasks.js";
import type { StateView } from "../src/types.js";

export function fleetState(count = 50): StateView {
  return {
    protocolVersion: 1, serverPid: 1, session: "fleet", stateVersion: 1,
    activeWorkspaceId: "w0", activeTabId: "t0", focusedPaneId: "p0", plugins: [], machines: [], tabs: [],
    panes: Array.from({ length: count }, (_, i) => ({
      id: `p${i}`, title: "", command: "claude", agent: i % 2 ? "codex" : "claude", cwd: `/work/project-${Math.floor(i / 10)}`,
      status: (["blocked", "done", "unknown", "working", "idle"] as const)[i % 5]!, exitCode: null, updatedAt: "2026-09-23T10:00:00Z",
      signal: { source: "screen", confidence: "inferred", reason: "Screen matches approval prompt", observedAt: 1000 + i, expiresAt: null },
      task: updateTask(null, { title: `Task ${i}: improve service ${i}`, summary: `Progress for task ${i}`, nextAction: "Inspect changes", review: i % 5 === 1 ? "requested" : "none" }, "fixture", undefined, 1000 + i),
    })),
    workspaces: Array.from({ length: Math.ceil(count / 10) }, (_, w) => ({
      id: `w${w}`, name: `Project ${w}`, rootPath: `/work/project-${w}`, activeTabId: `t${w * 10}`,
      tabs: Array.from({ length: Math.min(10, count - w * 10) }, (_, i) => ({
        id: `t${w * 10 + i}`, name: `Agent ${i}`, layout: { kind: "pane" as const, paneId: `p${w * 10 + i}` },
      })),
    })),
  };
}

const rowTexts = (state: StateView, sort: "spaces" | "status") =>
  sidebarRows(state, {
    width: 40, height: 60, focusedPaneId: "p0", activeWorkspaceId: "w0",
    indicators: "symbols", sort, mouse: false, navigateWorkspaceId: null, compact: false,
  }).map((row) => row.segments.map((segment) => segment.text).join(""));

describe("agent attention lanes", () => {
  it("prioritizes oldest blockers, pending reviews and uncertainty across workspaces", () => {
    const state = fleetState();
    const entries = deskEntries(state);
    expect(entries.slice(0, 10).every(entry => entry.lane === "blocked")).toBe(true);
    expect(entries.slice(10, 20).every(entry => entry.lane === "review")).toBe(true);
    expect(entries.slice(20, 30).every(entry => entry.lane === "unknown")).toBe(true);
    state.panes[1]!.status = "idle"; // Looking at a pane does not acknowledge its task.
    expect(deskEntries(state).find(entry => entry.pane.id === "p1")?.lane).toBe("review");
  });

  it("keeps disconnected remote agents in the uncertainty queue with distinct IDs", () => {
    const state = fleetState(1);
    state.machines = [{ id: "edge", label: "Edge", target: "host", port: 22, enabled: true, reachable: false,
      status: "reconnecting", checkedAt: null, error: "offline", remoteSession: "default",
      remote: { serverPid: 2, protocolVersion: 1, workspaces: 1, tabs: 1, paneCount: 1, workspaceList: state.workspaces,
        activeWorkspaceId: "w0", agents: [], panes: [{ paneId: "p0", title: "Remote task", agent: "claude", status: "working" }] } }];
    const entries = deskEntries(state);
    expect(entries.map(e => e.key)).toEqual(["local:p0", "edge:p0"]);
    expect(entries[1]).toMatchObject({ lane: "unknown", online: false });
  });
});

describe("sidebar agent grouping", () => {
  it("keeps the oldest attention first despite recent output or status updates", () => {
    const state = fleetState(10);
    state.panes[0]!.signal!.changedAt = 2000;
    state.panes[5]!.signal!.changedAt = 500;
    state.panes[5]!.updatedAt = "2026-09-24T12:00:00Z";
    state.panes[6]!.task!.reviewRequestedAt = 400;
    state.panes[6]!.updatedAt = "2026-09-24T12:00:00Z";
    expect(agentEntries(state, "status").map((entry) => entry.pane.id))
      .toEqual(deskEntries(state).map((entry) => entry.pane.id));
    expect(agentEntries(state, "status").slice(0, 4).map((entry) => entry.pane.id))
      .toEqual(["p5", "p0", "p6", "p1"]);
  });

  it("includes task panes without a detected agent", () => {
    const state = fleetState(1);
    state.panes[0]!.agent = null;
    expect(agentEntries(state, "status").map((entry) => entry.pane.id)).toEqual(["p0"]);
    expect(rowTexts(state, "status").some((line) => line.includes("NEEDS YOU"))).toBe(true);
  });

  it("preserves an explicit agent view sort in rendered rows", () => {
    const state = fleetState(5);
    state.agentView = { source: "fixture", label: "Custom", filter: null, sort: [{ field: "pane_order", order: "desc" }, { field: "tab_order", order: "desc" }] };
    const rows = sidebarRows(state, {
      width: 40, height: 60, focusedPaneId: "p0", activeWorkspaceId: "w0",
      indicators: "symbols", sort: "status", mouse: true, navigateWorkspaceId: null, compact: false,
    });
    const rendered = [...new Set(rows.flatMap((row) => row.target?.kind === "agent" ? [row.target.paneId] : []))];
    expect(rendered).toEqual(["p4", "p3", "p2", "p1", "p0"]);
    expect(rows.some((row) => row.segments.some((segment) => segment.text.includes("NEEDS YOU")))).toBe(false);
  });

  it.each(["spaces", "status"] as const)("pages through every agent in a bounded %s viewport", (sort) => {
    const state = fleetState();
    const options: SidebarOptions = {
      width: 26, height: 24, focusedPaneId: "p0", activeWorkspaceId: "w0",
      indicators: "symbols", sort, mouse: true, navigateWorkspaceId: null, compact: false,
    };
    const seen = new Set<string>();
    let offset = 0;
    for (let page = 0; page < 100; page += 1) {
      const rows = sidebarRows(state, { ...options, agentScroll: offset });
      expect(rows).toHaveLength(24);
      expect(rows.every((row) => displayWidth(row.segments.map((segment) => segment.text).join("")) <= 25)).toBe(true);
      for (const row of rows) if (row.target?.kind === "agent") seen.add(row.target.paneId);
      const next = rows.flatMap((row) => row.segments).find((segment) =>
        segment.target?.kind === "agent-scroll" && segment.target.offset > offset)?.target;
      if (next?.kind !== "agent-scroll") break;
      offset = next.offset;
    }
    expect(seen.size).toBe(50);
    const last = sidebarRows(state, { ...options, agentScroll: offset });
    expect(last.flatMap((row) => row.segments).some((segment) =>
      segment.target?.kind === "agent-scroll" && segment.target.offset < offset)).toBe(true);
    const focused = sidebarRows(state, { ...options, focusedPaneId: "p49" });
    expect(focused.some((row) => row.target?.kind === "agent" && row.target.paneId === "p49")).toBe(true);
  });

  it("groups agents under status headers in lane order", () => {
    const lines = rowTexts(fleetState(5), "status");
    const headers = ["NEEDS YOU", "REVIEW", "CHECK STATUS", "WORKING", "READY"]
      .map((label) => lines.findIndex((line) => line.includes(label)));
    expect(headers.every((index) => index >= 0)).toBe(true);
    expect([...headers].sort((a, b) => a - b)).toEqual(headers);
    expect(lines.some((line) => line.includes("AGENTS") && line.includes("status"))).toBe(true);
  });

  it("leaves the workspace-grouped sidebar flat", () => {
    const lines = rowTexts(fleetState(10), "spaces");
    for (const label of ["NEEDS YOU", "REVIEW", "CHECK STATUS", "WORKING", "READY"]) {
      expect(lines.some((line) => line.includes(label))).toBe(false);
    }
    expect(lines.some((line) => line.includes("AGENTS") && line.includes("spaces"))).toBe(true);
  });

  it("keeps the legacy priority sort as status order", () => {
    const state = fleetState(10);
    expect(agentEntries(state, "priority").map((entry) => entry.pane.id))
      .toEqual(agentEntries(state, "status").map((entry) => entry.pane.id));
    expect(normalizeAgentSort("priority")).toBe("status");
    expect(normalizeAgentSort("spaces")).toBe("spaces");
  });

  it("parses legacy agent_panel_sort values", () => {
    expect(parseConfig({ ui: { agent_panel_sort: "priority" } }, []).ui.agent_panel_sort).toBe("status");
    expect(parseConfig({ ui: { agent_panel_sort: "workspaces" } }, []).ui.agent_panel_sort).toBe("spaces");
  });
});
