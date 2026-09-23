import { describe, expect, it } from "vitest";
import { PluginLifecycleTracker } from "../src/server/pluginLifecycle.js";
import type { StateView } from "../src/types.js";

function session(): StateView {
  const workspaces = [1, 2].map((number) => ({
    id: `w${number}`, name: `workspace ${number}`, rootPath: "/tmp",
    activeTabId: `t${number}`,
    tabs: [{ id: `t${number}`, name: `tab ${number}`, layout: { kind: "pane" as const, paneId: `p${number}` } }],
  }));
  return {
    protocolVersion: 1, session: "test", serverPid: 1, stateVersion: 1,
    workspaces, tabs: workspaces[0]!.tabs,
    activeWorkspaceId: "w1", activeTabId: "t1", focusedPaneId: "p1",
    panes: [1, 2].map((number) => ({
      id: `p${number}`, title: "shell", command: null, cwd: "/tmp",
      agent: null, status: "unknown", exitCode: null, updatedAt: "2026-09-23T00:00:00Z",
    })),
    plugins: [], machines: [],
  };
}

describe("plugin lifecycle snapshots", () => {
  it("preserves the earlier state when live workspace and layout objects mutate", () => {
    const state = session();
    const tracker = new PluginLifecycleTracker(state);
    state.workspaces[0]!.name = "research";
    state.workspaces[0]!.tabs[0]!.name = "review";
    const events = tracker.poll(state);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "workspace.renamed", data: expect.objectContaining({ workspace_id: "w1", label: "research" }) }),
      expect.objectContaining({ name: "tab.renamed", data: expect.objectContaining({ tab_id: "t1", label: "review" }) }),
    ]));
    expect(tracker.poll(state)).toEqual([]);
  });

  it("reports closures without reporting the surviving workspace as moved", () => {
    const state = session();
    const tracker = new PluginLifecycleTracker(state);
    state.workspaces.shift();
    state.panes.shift();
    state.activeWorkspaceId = "w2";
    state.activeTabId = "t2";
    state.focusedPaneId = "p2";
    state.tabs = state.workspaces[0]!.tabs;
    const events = tracker.poll(state);
    expect(events.map((event) => event.name)).toEqual(expect.arrayContaining([
      "workspace.closed", "tab.closed", "pane.closed", "workspace.focused",
    ]));
    expect(events.some((event) => event.name.endsWith(".moved"))).toBe(false);
  });
});
