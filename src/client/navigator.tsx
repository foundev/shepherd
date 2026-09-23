import { paneIds } from "../server/layout.js";
import type { AgentStatus, StateView, WorkspaceView } from "../types.js";
import {
  statusIcon,
  tabLabel,
  truncateText,
  workspaceLabel,
  type ChromeRow,
  type Segment,
} from "./chrome.js";
import { displayWidth } from "./geometry.js";
import { centeredRect, Panel, PanelRows } from "./panels.js";
import { statusColor, theme } from "./theme.js";

export type StatusFilter = "all" | AgentStatus;

export interface NavigatorItem {
  kind: "workspace" | "pane";
  workspace: WorkspaceView;
  paneId?: string;
  label: string;
  agent?: string | null;
  status?: AgentStatus;
  path: string;
  tabName?: string;
  last?: boolean;
}

/** Shepherd's "Go to" list: each workspace followed by its panes, filtered by
 * a search over names, agents, tabs, workspaces, branches and paths, and
 * by agent status. */
export function navigatorItems(
  state: StateView,
  query: string,
  filter: StatusFilter,
): NavigatorItem[] {
  const needle = query.trim().toLowerCase();
  const items: NavigatorItem[] = [];
  for (const workspace of state.workspaces) {
    const panes: NavigatorItem[] = [];
    workspace.tabs.forEach((tab, tabIndex) => {
      const ids = paneIds(tab.layout);
      ids.forEach((paneId, index) => {
        const pane = state.panes.find((entry) => entry.id === paneId);
        if (!pane) return;
        const name = pane.task?.title || pane.title || pane.agent || "terminal";
        const tabName = tabLabel(tab, tabIndex);
        const label = ids.length === 1
          ? (workspace.tabs.length > 1 ? `${tabName} · ${name}` : name)
          : `${workspace.tabs.length > 1 ? `${tabName} · ` : ""}${name} · ${index + 1}`;
        const status = pane.agent ? pane.status : "unknown";
        if (filter !== "all" && status !== filter) return;
        const haystack = [
          label,
          pane.agent ?? "terminal",
          tabName,
          workspaceLabel(workspace),
          workspace.git?.branch ?? "",
          pane.cwd,
          pane.task?.summary ?? "",
          pane.task?.nextAction ?? "",
          pane.task?.blocker ?? "",
        ].join(" ").toLowerCase();
        if (needle && !haystack.includes(needle)) return;
        panes.push({
          kind: "pane",
          workspace,
          paneId,
          label,
          agent: pane.agent,
          status,
          path: pane.cwd,
          tabName,
        });
      });
    });
    if (panes.length === 0) continue;
    const last = panes[panes.length - 1];
    if (last) last.last = true;
    items.push({
      kind: "workspace",
      workspace,
      label: workspaceLabel(workspace),
      path: workspace.rootPath,
    });
    items.push(...panes);
  }
  return items;
}

export function navigatorRows(
  items: NavigatorItem[],
  selected: number,
  width: number,
  height: number,
  focusedPaneId: string,
  indicators: "dots" | "symbols",
): ChromeRow[] {
  const offset = Math.max(0, Math.min(selected - Math.floor(height / 2), items.length - height));
  return items.slice(offset, offset + height).map((item, index) => {
    const isSelected = offset + index === selected;
    const base = isSelected
      ? { color: theme.panelContrast, backgroundColor: theme.brand, bold: true }
      : { color: theme.text };
    if (item.kind === "workspace") {
      const branch = item.workspace.git?.branch ?? "";
      const left = ` ${item.label}`;
      const gap = Math.max(1, width - displayWidth(left) - displayWidth(branch) - 1);
      return {
        background: isSelected ? theme.brand : undefined,
        segments: [
          { text: truncateText(left, width), ...base, bold: true },
          { text: " ".repeat(gap), ...base },
          { text: branch ? `${branch} ` : "", ...(isSelected ? base : { color: theme.muted }) },
        ],
      };
    }
    const status = item.status ?? "unknown";
    const connector = item.last ? "└─ " : "├─ ";
    const current = item.paneId === focusedPaneId ? "◆ " : "";
    const columns = width >= 64 ? 2 : width >= 36 ? 1 : 0;
    const right: Segment[] = [];
    if (columns >= 1) {
      right.push({
        text: (item.agent ?? "terminal").slice(0, 11).padEnd(11),
        ...(isSelected ? base : { color: theme.muted }),
      });
    }
    if (columns >= 2) {
      right.push({
        text: (item.agent ? status : "shell").slice(0, 11).padEnd(11),
        ...(isSelected ? base : { color: statusColor[status] ?? theme.muted }),
      });
    }
    const rightWidth = right.reduce((sum, segment) => sum + displayWidth(segment.text), 0);
    const prefix = ` ${connector}${current}`;
    const labelWidth = Math.max(1, width - rightWidth - displayWidth(prefix) - 2);
    const label = truncateText(item.label, labelWidth);
    const gap = Math.max(1, width - rightWidth - displayWidth(prefix) - 2 - displayWidth(label));
    return {
      background: isSelected ? theme.brand : undefined,
      segments: [
        { text: ` ${connector}`, ...(isSelected ? base : { color: theme.muted }) },
        { text: current, ...(isSelected ? base : { color: theme.brand }) },
        {
          text: statusIcon(status, indicators),
          ...(isSelected ? base : { color: statusColor[status] }),
        },
        { text: " ", ...base },
        { text: label, ...base },
        { text: " ".repeat(gap), ...base },
        ...right,
      ],
    };
  });
}

export interface NavigatorState {
  query: string;
  searching: boolean;
  filter: StatusFilter;
  selected: number;
}

export function NavigatorOverlay({
  state,
  navigator,
  columns,
  rows,
  indicators,
}: {
  state: StateView;
  navigator: NavigatorState;
  columns: number;
  rows: number;
  indicators: "dots" | "symbols";
}) {
  const rect = centeredRect(columns, rows, Math.min(columns - 4, 116), Math.min(rows - 2, 42));
  const inner = rect.width - 2;
  const items = navigatorItems(state, navigator.query, navigator.filter);
  const paneCount = items.filter((item) => item.kind === "pane").length;
  const listHeight = Math.max(1, rect.height - 2 - 2 - 3);
  const selectedItem = items[navigator.selected];
  const searchText = navigator.query
    ? ` / ${navigator.query}`
    : navigator.filter !== "all"
      ? ` / ${navigator.filter}`
      : " / search agents and terminals";
  const count = `${paneCount} terminal${paneCount === 1 ? "" : "s"} `;
  const header: ChromeRow = {
    segments: [
      {
        text: truncateText(searchText, inner - displayWidth(count) - 1),
        color: navigator.searching ? theme.text : theme.muted,
      },
      {
        text: " ".repeat(Math.max(1, inner - displayWidth(searchText) - displayWidth(count))),
      },
      { text: count, color: theme.muted },
    ],
  };
  const list = items.length === 0
    ? [{ segments: [{ text: " No matching agents or terminals", color: theme.muted }] }]
    : navigatorRows(items, navigator.selected, inner, listHeight, state.focusedPaneId, indicators);
  while (list.length < listHeight) list.push({ segments: [] });
  const tab = selectedItem?.tabName;
  const detail = selectedItem
    ? ` ${[workspaceLabel(selectedItem.workspace), tab, selectedItem.paneId].filter(Boolean).join(" / ")}`
    : "";
  const footer = navigator.searching
    ? " search type · move ↑↓/ctrl+n/p · open enter · back esc"
    : " ↑↓/j/k rows · ←→ workspace · / search · a/b/w/i/d filter · enter open · esc close";
  return (
    <Panel rect={rect} title="Go to">
      <PanelRows
        width={inner}
        rows={[
          header,
          { segments: [{ text: "─".repeat(inner), color: theme.surfaceDim }] },
          ...list,
          { segments: [{ text: truncateText(detail, inner), color: theme.subtext }] },
          { segments: [{ text: truncateText(` ${selectedItem?.path ?? ""}`, inner), color: theme.muted }] },
          { segments: [{ text: truncateText(footer, inner), color: theme.muted }] },
        ]}
      />
    </Panel>
  );
}

/** Next selectable index (pane rows only) from `from` in `direction`. */
export function nextPaneItem(
  items: NavigatorItem[],
  from: number,
  direction: 1 | -1,
  steps = 1,
): number {
  let index = from;
  let moved = 0;
  while (moved < steps) {
    let next = index + direction;
    while (next >= 0 && next < items.length && items[next]?.kind !== "pane") {
      next += direction;
    }
    if (next < 0 || next >= items.length) break;
    index = next;
    moved += 1;
  }
  return index;
}

export function firstPaneItem(items: NavigatorItem[], paneId?: string): number {
  const current = paneId ? items.findIndex((item) => item.paneId === paneId) : -1;
  if (current !== -1) return current;
  return Math.max(0, items.findIndex((item) => item.kind === "pane"));
}
