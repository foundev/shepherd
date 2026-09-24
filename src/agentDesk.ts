import type { PaneView, StateView, WorkspaceView } from "./types.js";
import { paneIds } from "./server/layout.js";

export type DeskLane = "blocked" | "review" | "unknown" | "working" | "ready";
export const LANE_ORDER: DeskLane[] = ["blocked", "review", "unknown", "working", "ready"];
export const LANE_LABELS: Record<DeskLane, string> = {
  blocked: "NEEDS YOU", review: "REVIEW", unknown: "CHECK STATUS", working: "WORKING", ready: "READY",
};

export interface DeskEntry {
  key: string;
  pane: PaneView;
  workspace: WorkspaceView | undefined;
  workspaceLabel: string;
  tabLabel: string;
  machineId: string | null;
  machineLabel: string;
  online: boolean;
  lane: DeskLane;
  since: number;
}

export function deskLane(pane: PaneView, online = true): DeskLane {
  if (!online) return "unknown";
  if (pane.status === "blocked" || pane.task?.blocker || pane.task?.checkStatus === "failed") return "blocked";
  if (pane.task?.review === "requested" || (pane.status === "done" && pane.task?.review !== "reviewed")) return "review";
  if (!pane.agent || pane.status === "unknown") return "unknown";
  return pane.status === "working" ? "working" : "ready";
}

/** One pass per machine; stable IDs keep selection on the same agent as priorities change. */
export function deskEntries(state: StateView): DeskEntry[] {
  const result: DeskEntry[] = [];
  const add = (panes: PaneView[], workspaces: WorkspaceView[], machineId: string | null, machineLabel: string, online: boolean) => {
    const locations = new Map<string, { workspace: WorkspaceView; tabLabel: string }>();
    for (const workspace of workspaces) workspace.tabs.forEach((tab, i) => {
      for (const id of paneIds(tab.layout)) locations.set(id, { workspace, tabLabel: tab.name || `Tab ${i + 1}` });
    });
    for (const pane of panes) {
      if (!pane.agent && !pane.task) continue;
      const location = locations.get(pane.id);
      result.push({ key: `${machineId ?? "local"}:${pane.id}`, pane, ...location,
        workspace: location?.workspace, tabLabel: location?.tabLabel ?? "",
        workspaceLabel: location?.workspace.label || location?.workspace.name || location?.workspace.rootPath.split("/").pop() || "Workspace",
        machineId, machineLabel, online, lane: deskLane(pane, online),
        since: deskLane(pane, online) === "review" ? pane.task?.reviewRequestedAt ?? pane.signal?.changedAt ?? pane.signal?.observedAt ?? 0
          : pane.signal?.changedAt ?? pane.signal?.observedAt ?? (Date.parse(pane.updatedAt) || 0),
      });
    }
  };
  add(state.panes, state.workspaces, null, "Local", true);
  for (const machine of state.machines) {
    if (!machine.remote) continue;
    add(machine.remote.panes.map(pane => ({ ...pane, id: pane.paneId, command: null, exitCode: null,
      cwd: pane.cwd ?? "", updatedAt: pane.updatedAt ?? machine.checkedAt ?? "" })), machine.remote.workspaceList,
    machine.id, machine.label, machine.status === "online" && machine.reachable);
  }
  return result.sort((a, b) => LANE_ORDER.indexOf(a.lane) - LANE_ORDER.indexOf(b.lane) || a.since - b.since || a.key.localeCompare(b.key, undefined, { numeric: true }));
}
