/** Pure layout for the phone-width presentation (at or below
 * `ui.mobile_width_threshold` columns): a two-row status header over the
 * panes, and a full-screen switcher in place of the sidebar and tab bar.
 * Rendering and mouse hit-testing both use these rows. */
import {
  agentEntries,
  entryLabel,
  fit,
  machineStatusPresentation,
  remoteWorkspaceStatus,
  rightAligned,
  statusIcon,
  tabLabel,
  truncateText,
  workspaceEntries,
  workspaceLabel,
  workspaceStatus,
  LOCAL_MACHINE_ID,
  type ChromeRow,
  type Segment,
} from "./chrome.js";
import { displayWidth } from "./geometry.js";
import { sidebarStatusText } from "./sidebarTokens.js";
import { statusBackground, statusColor, statusForeground, theme } from "./theme.js";
import type { AgentStatus, StateView, WorkspaceView } from "../types.js";

/** Width of the header's switch button and the switcher's close button. */
export const MOBILE_BUTTON_WIDTH = 10;

export interface MobileOptions {
  width: number;
  indicators: "dots" | "symbols";
}

/** `tab 2 · 2/3`: the active tab and its position among several. */
export function compactTabStatus(workspace: WorkspaceView, activeTabId?: string): string {
  const tabs = workspace.tabs;
  const index = Math.max(0, tabs.findIndex((tab) =>
    tab.id === (activeTabId ?? workspace.activeTabId)
  ));
  const tab = tabs[index];
  const label = `tab ${tab ? tabLabel(tab, index) : "1"}`;
  return tabs.length > 1 ? `${label} · ${index + 1}/${tabs.length}` : label;
}

/** A button cell block: a divider then a centred label. */
function button(label: string, width: number, style: Partial<Segment>): Segment[] {
  const inner = Math.max(0, width - 1);
  const before = Math.max(0, Math.floor((inner - displayWidth(label)) / 2));
  const after = Math.max(0, inner - before - displayWidth(label));
  const background = theme.surface0;
  return [
    { text: "│", color: theme.surfaceDim, backgroundColor: background, target: style.target },
    {
      text: `${" ".repeat(before)}${truncateText(label, inner)}${" ".repeat(after)}`,
      color: theme.brand,
      bold: true,
      backgroundColor: background,
      ...style,
    },
  ];
}

/** The two header rows: the active workspace with its tab position, a
 * summary of agent states, and the switch button on the right. */
export function mobileHeaderRows(
  state: StateView,
  options: MobileOptions & { height: number },
): ChromeRow[] {
  const width = Math.max(1, options.width);
  const buttonWidth = Math.min(MOBILE_BUTTON_WIDTH, width);
  const left = Math.max(0, width - buttonWidth - 1);
  const target = { kind: "switcher-open" as const };
  const workspace = state.workspaces.find((entry) => entry.id === state.activeWorkspaceId);
  const blocked = state.panes.some((pane) => pane.agent && pane.status === "blocked");

  let status: Segment[];
  if (!workspace) {
    status = fit([{ text: " no workspace", color: theme.text }], left);
  } else {
    const rollup = workspaceStatus(workspace, state.panes);
    status = rightAligned(
      [
        { text: ` ${statusIcon(rollup, options.indicators)} `, color: statusForeground[rollup], backgroundColor: statusColor[rollup], bold: true },
        { text: workspaceLabel(workspace), color: theme.text, bold: true },
      ],
      [{ text: compactTabStatus(workspace, state.activeTabId), color: theme.overlay1 }],
      left,
    );
  }
  const pad = (segments: Segment[]): Segment[] => {
    const used = segments.reduce((total, segment) => total + displayWidth(segment.text), 0);
    return [...segments, { text: " ".repeat(Math.max(0, width - buttonWidth - used)) }];
  };
  // The label sits on the second row when there is one; a blocked agent
  // anywhere puts a red mark in the button's top corner.
  const label = options.height > 1 ? "" : "switch";
  const top = button(label, buttonWidth, { target });
  if (blocked && buttonWidth > 2) {
    const body = top[1]!;
    top[1] = { ...body, text: body.text.slice(0, -1) };
    top.push({
      text: statusIcon("blocked", options.indicators),
      color: statusForeground.blocked,
      backgroundColor: theme.danger,
      target,
    });
  }
  const rows: ChromeRow[] = [{ segments: [...pad(status), ...top], background: theme.panelBg }];
  if (options.height > 1) {
    rows.push({
      segments: [...pad(agentSummary(state, options.indicators, left)), ...button("switch", buttonWidth, { target })],
      background: theme.panelBg,
    });
  }
  return rows;
}

/** `● 1 blocked · 2 working`, most urgent first; `no agents` or
 * `all idle` when nothing needs attention. */
function agentSummary(
  state: StateView,
  indicators: "dots" | "symbols",
  width: number,
): Segment[] {
  const agents = state.panes.filter((pane) => pane.agent);
  if (agents.length === 0) return fit([{ text: " no agents", color: theme.overlay1 }], width);
  const order: AgentStatus[] = ["blocked", "done", "unknown", "working", "idle"];
  const counts = order
    .map((status) => ({
      status,
      count: agents.filter((pane) =>
        (pane.status !== "blocked" && pane.task?.review === "requested" ? "done" : pane.status) === status
      ).length,
    }))
    .filter((entry) => entry.count > 0);
  if (counts.every((entry) => entry.status === "idle")) {
    return fit([{ text: " all idle", color: theme.overlay1 }], width);
  }
  const segments: Segment[] = [{ text: " " }];
  const animateWorking = indicators === "symbols" && !counts.some((entry) => entry.status === "blocked");
  let used = 1;
  for (const [index, { status, count }] of counts.entries()) {
    const separator = index === 0 ? "" : " · ";
    const text = `${statusIcon(status, indicators)} ${count} ${status === "done" ? "review" : status}`;
    if (used + displayWidth(separator + text) > width) {
      if (used + 2 <= width) segments.push({ text: " …", color: theme.muted });
      break;
    }
    if (separator) segments.push({ text: separator, color: theme.muted });
    segments.push({
      text,
      color: index === 0 ? statusForeground[status] : statusColor[status],
      backgroundColor: index === 0 ? statusColor[status] : statusBackground[status],
      bold: true,
      animate: status === "working" && animateWorking,
    });
    used += displayWidth(separator + text);
  }
  return segments;
}

export interface SwitcherOptions extends MobileOptions {
  sort: "spaces" | "status" | "priority";
  /** Workspace highlighted by keyboard navigation. */
  navigateWorkspaceId: string | null;
  /** Labels of the global menu, in order. */
  menu: string[];
}

/** The switcher's scrolling list and where each local workspace sits in
 * it, for keeping the highlighted one on screen. */
export interface SwitcherDocument {
  items: ChromeRow[];
  workspaceRows: Map<string, { start: number; end: number }>;
}

function section(label: string): ChromeRow {
  return { background: theme.surface0, segments: [{ text: ` ${label}`, color: theme.brand, bold: true }] };
}

/** Sections top to bottom: machines (with saved machines), agents,
 * spaces, tabs of the active workspace, and the menu. Entries take two
 * lines, a title and a muted detail line. `width` excludes the scrollbar
 * column. */
export function switcherDocument(state: StateView, options: SwitcherOptions): SwitcherDocument {
  const width = Math.max(1, options.width);
  const items: ChromeRow[] = [];
  const workspaceRows = new Map<string, { start: number; end: number }>();
  const machinesMode = state.machines.length > 0;
  const entry = (
    first: Segment[],
    detail: string,
    target: ChromeRow["target"],
    background?: string,
    dim = false,
  ) => {
    const style = (segments: Segment[]) => dim
      ? segments.map((segment) => ({ ...segment, dim: true }))
      : segments;
    items.push({ target, background, segments: style(fit(first, width)) });
    items.push({
      target,
      background,
      segments: style(fit([{ text: detail, color: theme.muted }], width)),
    });
  };

  if (machinesMode) {
    items.push(section("machines"));
    entry(
      [
        { text: "  " },
        { text: "●", color: theme.success },
        { text: " Local", color: theme.text, bold: true },
      ],
      "    this machine",
      { kind: "machine", id: LOCAL_MACHINE_ID },
    );
    for (const machine of state.machines) {
      const presentation = machineStatusPresentation(machine.status);
      entry(
        [
          { text: "  " },
          { text: presentation.glyph, color: presentation.color },
          { text: ` ${machine.label}`, color: theme.text, bold: true },
        ],
        `    ${presentation.label}`,
        { kind: "machine", id: machine.id },
      );
    }
  }

  const agents = agentEntries(state, options.sort);
  if (agents.length > 0 || state.agentView) {
    items.push(section(state.agentView ? `agents · ${state.agentView.label}` : "agents"));
    if (agents.length === 0) {
      items.push({ segments: [{ text: "  no matching agents", color: theme.muted, dim: true }] });
    }
    for (const agent of agents) {
      const name = agent.pane.displayAgent || agent.pane.agent || "agent";
      const detail = [
        ...(agent.workspace.tabs.length > 1 || agent.tab.name
          ? [tabLabel(agent.tab, agent.tabIndex)]
          : []),
        sidebarStatusText(agent.pane.status),
        name,
      ].join(" · ");
      entry(
        [
          { text: "  " },
          {
            text: statusIcon(agent.pane.status, options.indicators),
            color: statusForeground[agent.pane.status],
            backgroundColor: statusColor[agent.pane.status],
            bold: true,
          },
          {
            text: ` ${machinesMode ? "Local · " : ""}${workspaceLabel(agent.workspace)}`,
            color: theme.text,
            bold: true,
          },
        ],
        `  ${detail}`,
        { kind: "agent", paneId: agent.pane.id },
        agent.pane.id === state.focusedPaneId ? theme.activeRow : undefined,
      );
    }
  }

  items.push(section("spaces"));
  items.push({
    target: { kind: "new-workspace" },
    segments: [{ text: "  + new workspace", color: theme.brand, bold: true }],
  });
  const spaces = (
    workspaces: WorkspaceView[],
    status: (workspace: WorkspaceView) => AgentStatus,
    machine: { id: string; label: string; stale: boolean } | null,
  ) => {
    for (const space of workspaceEntries(workspaces)) {
      const workspace = space.workspace;
      const local = machine === null;
      const start = items.length;
      const rollup = status(workspace);
      const connector = space.child ? (space.child.last ? "└─ " : "├─ ") : "";
      const detailPrefix = space.child ? (space.child.last ? "     " : "  │  ") : "  ";
      const background = local && workspace.id === options.navigateWorkspaceId
        ? theme.selection
        : local && workspace.id === state.activeWorkspaceId
          ? theme.activeRow
          : undefined;
      const prefix = machinesMode ? `${machine?.label ?? "Local"} · ` : "";
      entry(
        [
          { text: `  ${connector}`, color: theme.muted },
          { text: statusIcon(rollup, options.indicators), color: statusForeground[rollup], backgroundColor: statusColor[rollup], bold: true },
          { text: ` ${prefix}${entryLabel(space)}`, color: theme.text, bold: true },
        ],
        `${detailPrefix}${workspace.git?.branch || "shell"} · ${compactTabStatus(workspace)}${
          machine?.stale ? " · offline" : ""
        }`,
        local
          ? { kind: "workspace", id: workspace.id }
          : { kind: "remote-workspace", machineId: machine.id, workspaceId: workspace.id },
        background,
        machine?.stale ?? false,
      );
      if (local) workspaceRows.set(workspace.id, { start, end: items.length });
    }
  };
  spaces(state.workspaces, (workspace) => workspaceStatus(workspace, state.panes), null);
  for (const machine of state.machines) {
    if (!machine.remote) continue;
    spaces(
      machine.remote.workspaceList ?? [],
      (workspace) => remoteWorkspaceStatus(workspace, machine),
      { id: machine.id, label: machine.label, stale: machine.status !== "online" },
    );
  }

  const active = state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId);
  if (active) {
    items.push(section("tabs"));
    items.push({
      target: { kind: "new-tab" },
      segments: [{ text: "  + new tab", color: theme.brand, bold: true }],
    });
    active.tabs.forEach((tab, index) => {
      const label = tab.name ? `${index + 1} · ${tab.name}` : `tab ${index + 1}`;
      items.push({
        target: { kind: "tab", id: tab.id },
        background: tab.id === state.activeTabId ? theme.activeRow : undefined,
        segments: fit([{ text: `  ${label}`, color: theme.text, bold: true }], width),
      });
    });
  }

  items.push(section("menu"));
  options.menu.forEach((label, index) => {
    items.push({
      target: { kind: "menu-item", index },
      segments: [{ text: `  ${label}`, color: theme.overlay1 }],
    });
  });
  return { items, workspaceRows };
}

/** Rows above the list: the title, the close button and a rule. */
const SWITCHER_HEAD = 3;

/** The scroll offset that keeps rows [start, end) inside a viewport. */
export function revealScroll(
  range: { start: number; end: number } | undefined,
  scroll: number,
  viewport: number,
): number {
  if (!range) return scroll;
  if (range.start < scroll) return range.start;
  if (range.end > scroll + viewport) return Math.max(0, range.end - viewport);
  return scroll;
}

/** Rows of the list viewport under the switcher's heading. */
export function switcherViewport(height: number): number {
  return Math.max(0, height - SWITCHER_HEAD);
}

/** The whole switcher screen, one row per screen line: heading with the
 * close button, a rule, then the visible slice of the list behind a
 * one-column scrollbar. Returns the clamped scroll offset too. */
export function switcherScreen(
  document: SwitcherDocument,
  options: { width: number; height: number; scroll: number },
): { rows: ChromeRow[]; scroll: number; maxScroll: number } {
  const width = Math.max(1, options.width);
  const buttonWidth = Math.min(MOBILE_BUTTON_WIDTH, width);
  const close = { kind: "switcher-close" as const };
  const rule: ChromeRow = { segments: [{ text: "─".repeat(width), color: theme.surfaceDim }] };
  if (options.height <= 2) {
    return { rows: [rule], scroll: 0, maxScroll: 0 };
  }
  const titleWidth = Math.max(0, width - buttonWidth);
  const title = fit([{ text: " switch", color: theme.text, bold: true }], titleWidth);
  const titlePad = titleWidth - title.reduce((total, segment) => total + displayWidth(segment.text), 0);
  const rows: ChromeRow[] = [
    {
      background: theme.panelBg,
      segments: [...title, { text: " ".repeat(titlePad) }, ...button("close", buttonWidth, {
        target: close,
        color: theme.overlay1,
      })],
    },
    {
      background: theme.panelBg,
      segments: [{ text: " ".repeat(titleWidth) }, ...button("×", buttonWidth, { target: close })],
    },
    rule,
  ];
  const viewport = switcherViewport(options.height);
  const total = document.items.length;
  const maxScroll = Math.max(0, total - viewport);
  const scroll = Math.max(0, Math.min(maxScroll, options.scroll));
  const thumb = maxScroll > 0 ? scrollThumb(total, viewport, scroll) : null;
  for (let index = 0; index < viewport; index += 1) {
    const item = document.items[scroll + index];
    const bar: Segment = thumb
      ? index >= thumb.start && index < thumb.end
        ? { text: "▌", color: theme.brand }
        : { text: "│", color: theme.surfaceDim }
      : { text: " " };
    const segments = item?.segments ?? [];
    const used = segments.reduce((sum, segment) => sum + displayWidth(segment.text), 0);
    rows.push({
      background: theme.panelBg,
      segments: [
        bar,
        // Row background fills the row but not the scrollbar column.
        ...segments.map((segment) => ({
          ...segment,
          target: segment.target ?? item?.target,
          backgroundColor: segment.backgroundColor ?? item?.background,
        })),
        {
          text: " ".repeat(Math.max(0, width - 1 - used)),
          backgroundColor: item?.background,
          target: item?.target,
        },
      ],
    });
  }
  return { rows, scroll, maxScroll };
}

function scrollThumb(total: number, viewport: number, scroll: number): { start: number; end: number } {
  const length = Math.max(1, Math.round((viewport * viewport) / Math.max(1, total)));
  const maxScroll = Math.max(1, total - viewport);
  const start = Math.min(viewport - length, Math.round((scroll / maxScroll) * (viewport - length)));
  return { start, end: start + length };
}
