import { describe, expect, it } from "vitest";
import { deskEntries } from "../src/agentDesk.js";
import { agentEntries, normalizeAgentSort, sidebarRows } from "../src/client/chrome.js";
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
