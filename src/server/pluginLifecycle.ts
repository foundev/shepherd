import type { StateView, TabView, WorkspaceView } from "../types.js";
import { paneIds } from "./layout.js";

/** Events that plugin hooks can subscribe to. These describe Shepherd state. */
export const LIFECYCLE_EVENTS = [
  "workspace.created", "workspace.closed", "workspace.renamed", "workspace.moved", "workspace.focused",
  "tab.created", "tab.closed", "tab.renamed", "tab.moved", "tab.focused",
  "pane.created", "pane.closed", "pane.updated", "pane.focused",
  "pane.agent_detected", "pane.agent_status_changed", "layout.updated",
] as const;

export interface PluginLifecycleEvent {
  name: string;
  data: Record<string, unknown>;
}

type LocatedTab = { tab: TabView; workspace: WorkspaceView; index: number };

function tabs(state: StateView): Map<string, LocatedTab> {
  return new Map(state.workspaces.flatMap((workspace) =>
    workspace.tabs.map((tab, index) => [tab.id, { tab, workspace, index }] as const)
  ));
}

function paneWorkspace(state: StateView, paneId: string): string | undefined {
  for (const workspace of state.workspaces) {
    if (workspace.tabs.some((tab) => paneIds(tab.layout).includes(paneId))) {
      return workspace.id;
    }
  }
  return undefined;
}

function snake(name: string): string {
  return name.replaceAll(".", "_");
}

/** Insertions and deletions don't count as moves of the surviving objects. */
function reordered(before: string[], after: string[]): Set<string> {
  const oldIds = new Set(before);
  const newIds = new Set(after);
  const oldOrder = before.filter((id) => newIds.has(id));
  return new Set(after.filter((id) => oldIds.has(id)).filter((id, index) => oldOrder[index] !== id));
}

/** Compares complete snapshots so hook payloads are independent of client focus. */
export class PluginLifecycleTracker {
  private previous: StateView;

  constructor(initial: StateView) {
    this.previous = structuredClone(initial);
  }

  poll(current: StateView): PluginLifecycleEvent[] {
    const before = this.previous;
    const after = structuredClone(current);
    this.previous = after;
    const events: PluginLifecycleEvent[] = [];
    const add = (name: string, data: Record<string, unknown>) => {
      events.push({ name, data: { type: snake(name), ...data } });
    };
    const oldWorkspaces = new Map(before.workspaces.map((workspace) => [workspace.id, workspace]));
    const newWorkspaces = new Map(after.workspaces.map((workspace) => [workspace.id, workspace]));
    const oldTabs = tabs(before);
    const newTabs = tabs(after);
    const oldPanes = new Map(before.panes.map((pane) => [pane.id, pane]));
    const newPanes = new Map(after.panes.map((pane) => [pane.id, pane]));
    const movedWorkspaces = reordered([...oldWorkspaces.keys()], [...newWorkspaces.keys()]);
    const movedTabs = new Set<string>();
    for (const workspace of after.workspaces) {
      const old = oldWorkspaces.get(workspace.id);
      if (!old) continue;
      for (const id of reordered(old.tabs.map((tab) => tab.id), workspace.tabs.map((tab) => tab.id))) {
        movedTabs.add(id);
      }
    }

    for (const workspace of after.workspaces) {
      const old = oldWorkspaces.get(workspace.id);
      if (!old) add("workspace.created", { workspace_id: workspace.id, workspace });
      else {
        if (old.name !== workspace.name) add("workspace.renamed", { workspace_id: workspace.id, label: workspace.label ?? workspace.name });
        if (movedWorkspaces.has(workspace.id)) {
          add("workspace.moved", { workspace_id: workspace.id });
        }
      }
    }
    for (const [id, workspace] of oldWorkspaces) {
      if (!newWorkspaces.has(id)) add("workspace.closed", { workspace_id: id, workspace });
    }
    for (const [id, entry] of newTabs) {
      const old = oldTabs.get(id);
      if (!old) add("tab.created", { tab_id: id, workspace_id: entry.workspace.id, tab: entry.tab });
      else {
        if (old.tab.name !== entry.tab.name) add("tab.renamed", { tab_id: id, workspace_id: entry.workspace.id, label: entry.tab.name });
        if (movedTabs.has(id) || old.workspace.id !== entry.workspace.id) add("tab.moved", { tab_id: id, workspace_id: entry.workspace.id, index: entry.index });
        if (JSON.stringify(old.tab.layout) !== JSON.stringify(entry.tab.layout)) add("layout.updated", { tab_id: id, workspace_id: entry.workspace.id, layout: entry.tab.layout });
      }
    }
    for (const [id, entry] of oldTabs) {
      if (!newTabs.has(id)) add("tab.closed", { tab_id: id, workspace_id: entry.workspace.id });
    }
    for (const [id, pane] of newPanes) {
      const old = oldPanes.get(id);
      const workspaceId = paneWorkspace(after, id);
      if (!old) {
        add("pane.created", { pane_id: id, workspace_id: workspaceId, pane });
        continue;
      }
      if (old.agent !== pane.agent) add("pane.agent_detected", { pane_id: id, workspace_id: workspaceId, agent: pane.agent });
      if (old.status !== pane.status) add("pane.agent_status_changed", { pane_id: id, workspace_id: workspaceId, agent: pane.agent, agent_status: pane.status });
      if (old.title !== pane.title || old.terminalTitle !== pane.terminalTitle) add("pane.updated", { pane_id: id, workspace_id: workspaceId, pane });
    }
    for (const [id] of oldPanes) {
      if (!newPanes.has(id)) add("pane.closed", { pane_id: id, workspace_id: paneWorkspace(before, id) });
    }
    if (before.activeWorkspaceId !== after.activeWorkspaceId) add("workspace.focused", { workspace_id: after.activeWorkspaceId });
    if (before.activeTabId !== after.activeTabId) add("tab.focused", { tab_id: after.activeTabId, workspace_id: after.activeWorkspaceId });
    if (before.focusedPaneId !== after.focusedPaneId) add("pane.focused", { pane_id: after.focusedPaneId, workspace_id: paneWorkspace(after, after.focusedPaneId) });
    return events;
  }
}
