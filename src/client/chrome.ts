/** Pure layout for expanded chrome: the sidebar rows and the tab bar.
 * Rendering and mouse hit-testing both use these models. */
import { paneIds } from "../server/layout.js";
import { applyAgentView } from "../agentView.js";
import { attentionSince, deskEntries, deskLane, LANE_LABELS, LANE_ORDER, type DeskLane } from "../agentDesk.js";
import { defaultSidebarConfig, type SidebarConfig } from "../config/sidebar.js";
import type {
  AgentStatus,
  AgentViewSpec,
  MachineStatus,
  PaneView,
  RemoteMachineView,
  StateView,
  TabView,
  WorkspaceView,
} from "../types.js";
import { displayWidth } from "./geometry.js";
import { resolveRows, sidebarStatusText, tokenSegments, type ResolvedToken, type TokenColors } from "./sidebarTokens.js";
import { statusBadgeSegments } from "./indicators.js";
import { statusBackground, statusColor, statusForeground, theme } from "./theme.js";

/** Drop a leading activity glyph from a terminal title used in sidebar tokens. */
function stripTitleActivity(title: string): string {
  return title.replace(/^[⠀-⣿▀-▟■-◿☀-➿•·*✳✶✻✽✢·]\s*/u, "") || title;
}

export type ClickTarget =
  | { kind: "workspace"; id: string }
  | { kind: "agent"; paneId: string }
  | { kind: "new-workspace" }
  | { kind: "menu" }
  | { kind: "agent-sort" }
  | { kind: "agent-scroll"; offset: number }
  | { kind: "sidebar-toggle" }
  | { kind: "tab"; id: string }
  | { kind: "new-tab" }
  | { kind: "tabs-left" }
  | { kind: "tabs-right" }
  | { kind: "group-toggle"; repoKey: string }
  /** The ▾/▸ arrow of a machine row; `id` is "local" or a machine ID. */
  | { kind: "machine-toggle"; id: string }
  | { kind: "machine"; id: string }
  | { kind: "remote-workspace"; machineId: string; workspaceId: string }
  /** The phone-width header's switch button and the switcher's close. */
  | { kind: "switcher-open" }
  | { kind: "switcher-close" }
  /** An entry of the global menu, by position. */
  | { kind: "menu-item"; index: number };

/** Machine ID used for the local daemon in the machines sidebar. */
export const LOCAL_MACHINE_ID = "local";

export interface Segment {
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
  /** Animate this working glyph locally without redrawing the application. */
  animate?: boolean;
  target?: ClickTarget;
}

export interface ChromeRow {
  segments: Segment[];
  background?: string;
  /** Clicking anywhere on the row not covered by a segment target. */
  target?: ClickTarget;
  /** Agent viewport bounds used by sidebar wheel input. */
  agentScroll?: { offset: number; maxOffset: number };
}

const STATUS_PRIORITY: AgentStatus[] = ["blocked", "done", "unknown", "working", "idle"];

export function statusIcon(status: AgentStatus, style: "dots" | "symbols"): string {
  if (style === "symbols") {
    return { blocked: "×", working: "◐", done: "✓", idle: "○", unknown: "·" }[status];
  }
  return { blocked: "●", working: "●", done: "●", idle: "○", unknown: "·" }[status];
}

/** Highest-priority status: blocked > done > working > idle > unknown. */
export function rollupStatus(statuses: AgentStatus[]): AgentStatus {
  for (const status of STATUS_PRIORITY) {
    if (statuses.includes(status)) return status;
  }
  return "unknown";
}

/** Compact, color-independent session summary for the tab strip. */
export function agentSummarySegments(state: StateView, pulse = 0): Segment[] {
  const entries = deskEntries(state);
  const count = (status: string) => entries.filter((entry) => entry.lane === status).length;
  const blocked = count("blocked");
  const working = count("working");
  const done = count("review");
  const unknown = count("unknown");
  const summary: { status: AgentStatus; label: string } = blocked > 0
    ? { status: "blocked", label: `${blocked} NEEDS YOU` }
    : done > 0
      ? { status: "done", label: `${done} TO REVIEW` }
      : unknown > 0
        ? { status: "unknown", label: `${unknown} CHECK STATUS` }
        : working > 0
          ? { status: "working", label: `${working} WORKING` }
        : entries.length > 0
          ? { status: "idle", label: `${entries.length} READY` }
          : { status: "unknown", label: "NO AGENTS" };
  return statusBadgeSegments(summary.status, { label: summary.label, pulse, animate: true })
    .map((segment) => ({ ...segment, target: { kind: "agent-sort" } }));
}

export function workspaceLabel(workspace: WorkspaceView): string {
  return workspace.name || workspace.label || workspace.id;
}

export function tabLabel(tab: TabView, index: number): string {
  return tab.name || String(index + 1);
}

export function workspacePanes(workspace: WorkspaceView, panes: PaneView[]): PaneView[] {
  const ids = new Set(workspace.tabs.flatMap((tab) => paneIds(tab.layout)));
  return panes.filter((pane) => ids.has(pane.id));
}

export function workspaceStatus(workspace: WorkspaceView, panes: PaneView[]): AgentStatus {
  return rollupStatus(
    workspacePanes(workspace, panes).filter((pane) => pane.agent).map((pane) => pane.status),
  );
}

export interface AgentEntry {
  pane: PaneView;
  workspace: WorkspaceView;
  workspaceIndex: number;
  tab: TabView;
  tabIndex: number;
}

/** Sidebar agent grouping: by workspace ("spaces") or by attention status. */
export type AgentSort = "spaces" | "status";

/** Maps legacy sort names ("priority" → "status") to the current grouping. */
export function normalizeAgentSort(sort: string): AgentSort {
  return sort === "spaces" ? "spaces" : "status";
}

export function agentEntries(
  state: StateView,
  sort: AgentSort | "priority",
  view: AgentViewSpec | null = state.agentView ?? null,
): AgentEntry[] {
  let entries: AgentEntry[] = [];
  const paneOrder = new Map<string, number>();
  state.workspaces.forEach((workspace, workspaceIndex) => {
    workspace.tabs.forEach((tab, tabIndex) => {
      paneIds(tab.layout).forEach((paneId, index) => {
        paneOrder.set(paneId, index + 1);
        const pane = state.panes.find((entry) => entry.id === paneId);
        if (pane && (pane.agent || pane.task)) entries.push({ pane, workspace, workspaceIndex, tab, tabIndex });
      });
    });
  });
  if (view) {
    const active = state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId);
    entries = applyAgentView(
      view,
      { workspaceId: active?.id ?? null, tabId: active?.activeTabId ?? null },
      entries,
      (entry) => ({
        status: entry.pane.status,
        workspaceId: entry.workspace.id,
        tabId: entry.tab.id,
        paneId: entry.pane.id,
        agent: entry.pane.agent,
        seen: entry.pane.status !== "done",
        stateChangeSeq: Date.parse(entry.pane.updatedAt) || null,
        tokens: entry.pane.tokens ?? {},
        workspaceOrder: entry.workspaceIndex,
        tabOrder: entry.tabIndex + 1,
        paneOrder: paneOrder.get(entry.pane.id) ?? 0,
      }),
    );
    if (view.sort.length > 0) return entries;
  }
  if (normalizeAgentSort(sort) === "status") {
    entries.sort((left, right) =>
      LANE_ORDER.indexOf(deskLane(left.pane)) - LANE_ORDER.indexOf(deskLane(right.pane)) ||
      attentionSince(left.pane) - attentionSince(right.pane) ||
      left.pane.id.localeCompare(right.pane.id, undefined, { numeric: true })
    );
  }
  return entries;
}

/** Status-group header color per attention lane. */
function laneColor(lane: DeskLane): string {
  switch (lane) {
    case "blocked": return theme.danger;
    case "review": return theme.cyan;
    case "working": return theme.warning;
    case "ready": return theme.success;
    default: return theme.muted;
  }
}

/** Status-group header glyph per attention lane. */
function laneGlyph(lane: DeskLane): string {
  switch (lane) {
    case "blocked": return "×";
    case "review": return "◇";
    case "working": return "◐";
    case "ready": return "○";
    default: return "?";
  }
}

function laneStatus(lane: DeskLane): AgentStatus {
  switch (lane) {
    case "review": return "done";
    case "ready": return "idle";
    default: return lane;
  }
}

/** Default leading indicators become readable status chips. Configured token
 * order and explicit text styling continue to take precedence. */
function entryTokenSegments(
  tokens: ResolvedToken[],
  colors: TokenColors,
  width: number,
  status: AgentStatus,
  focused: boolean,
  stale = false,
): Segment[] {
  const first = tokens[0];
  if (first?.kind !== "state_icon" || width < 8) return fit(tokenSegments(tokens, colors, width), width);
  const segments = tokenSegments([
    { ...first, text: ` ${first.text} ` },
    ...tokens.slice(1),
  ], colors, width);
  if (segments[0]) {
    const solid = focused && !stale && !first.style.fg && !first.style.dim;
    const chip: Segment = {
      ...segments[0],
      color: first.style.fg ?? (stale ? theme.muted : solid ? statusForeground[status] : statusColor[status]),
      backgroundColor: stale ? theme.surface0 : solid ? statusColor[status] : statusBackground[status],
      bold: first.style.bold ?? true,
    };
    segments.splice(0, 1,
      { ...chip, text: " " },
      { ...chip, text: first.text, animate: status === "working" && first.text === "◐" && !stale },
      { ...chip, text: " " },
    );
  }
  return fit(segments, width);
}

export function truncateText(text: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  let result = "";
  for (const character of text) {
    if (displayWidth(result + character) > width - 1) break;
    result += character;
  }
  return `${result}…`;
}

export function fit(segments: Segment[], width: number): Segment[] {
  const result: Segment[] = [];
  let used = 0;
  for (const segment of segments) {
    const remaining = width - used;
    if (remaining <= 0) break;
    const text = truncateText(segment.text, remaining);
    result.push({ ...segment, text });
    used += displayWidth(text);
  }
  return result;
}

export function rightAligned(left: Segment[], right: Segment[], width: number): Segment[] {
  const leftWidth = left.reduce((total, segment) => total + displayWidth(segment.text), 0);
  const rightWidth = right.reduce((total, segment) => total + displayWidth(segment.text), 0);
  if (leftWidth + rightWidth >= width) return fit([...left, ...right], width);
  return [...left, { text: " ".repeat(width - leftWidth - rightWidth) }, ...right];
}

export interface SidebarOptions {
  width: number;
  height: number;
  focusedPaneId: string;
  activeWorkspaceId: string;
  indicators: "dots" | "symbols";
  sort: AgentSort | "priority";
  /** First agent row shown; defaults to revealing the focused pane. */
  agentScroll?: number;
  mouse: boolean;
  /** Workspace highlighted in navigate mode. */
  navigateWorkspaceId: string | null;
  compact: boolean;
  /** Repositories whose worktree children are collapsed. */
  collapsedGroups?: Set<string>;
  /** Machines ("local" or machine IDs) whose workspaces are hidden. */
  collapsedMachines?: Set<string>;
  /** Remote workspace currently shown, highlighted in the sidebar. */
  selectedRemote?: { machineId: string; workspaceId: string } | null;
  /** `[ui.sidebar]` token rows; defaults to Shepherd's layout. */
  sidebar?: SidebarConfig;
}

/** Shepherd's endpoint status glyphs: ◐ connecting/reconnecting, ● online,
 * ! attention, · disabled (and ○ for a bridge closed while unused). */
export function machineStatusPresentation(status: MachineStatus): {
  glyph: string;
  label: string;
  color: string;
} {
  switch (status) {
    case "online":
      return { glyph: "●", label: "online", color: theme.success };
    case "connecting":
      return { glyph: "◐", label: "connecting", color: theme.warning };
    case "reconnecting":
      return { glyph: "◐", label: "reconnecting", color: theme.warning };
    case "attention":
      return { glyph: "!", label: "attention", color: theme.danger };
    case "disabled":
      return { glyph: "·", label: "disabled", color: theme.muted };
    case "idle":
      return { glyph: "○", label: "idle", color: theme.muted };
    default:
      // An older daemon (for example over --remote) reports no status.
      return { glyph: "·", label: "unknown", color: theme.muted };
  }
}

/** Agent status of a remote workspace, from the machine's pane summaries. */
export function remoteWorkspaceStatus(
  workspace: WorkspaceView,
  machine: RemoteMachineView,
): AgentStatus {
  const ids = new Set(workspace.tabs.flatMap((tab) => paneIds(tab.layout)));
  return rollupStatus(
    (machine.remote?.panes ?? [])
      .filter((pane) => ids.has(pane.paneId) && pane.agent)
      .map((pane) => pane.status),
  );
}

export interface WorkspaceEntry {
  workspace: WorkspaceView;
  /** Set for a linked worktree shown under its repository's workspace. */
  child?: { last: boolean };
  /** Set for a workspace that has worktree children. */
  group?: { repoKey: string; collapsed: boolean };
}

/** Workspaces in sidebar order: each repository's main workspace followed
 * by its open linked worktrees (Shepherd's worktree groups). */
export function workspaceEntries(
  workspaces: WorkspaceView[],
  collapsed: Set<string> = new Set(),
  focusedId = "",
): WorkspaceEntry[] {
  const parents = new Map<string, WorkspaceView>();
  for (const workspace of workspaces) {
    if (workspace.git && !workspace.git.linked && !parents.has(workspace.git.repoKey)) {
      parents.set(workspace.git.repoKey, workspace);
    }
  }
  const entries: WorkspaceEntry[] = [];
  for (const workspace of workspaces) {
    const git = workspace.git;
    if (git?.linked && parents.has(git.repoKey)) continue;
    const children = git && !git.linked
      ? workspaces.filter((entry) =>
        entry.git?.linked && entry.git.repoKey === git.repoKey
      )
      : [];
    const isCollapsed = Boolean(git && collapsed.has(git.repoKey));
    entries.push({
      workspace,
      group: children.length > 0 && git
        ? { repoKey: git.repoKey, collapsed: isCollapsed }
        : undefined,
    });
    const visible = isCollapsed
      ? children.filter((child) => child.id === focusedId)
      : children;
    visible.forEach((child, index) => {
      entries.push({ workspace: child, child: { last: index === visible.length - 1 } });
    });
  }
  return entries;
}

/** Linked worktrees are labelled by branch, without a worktree/ prefix. */
export function entryLabel(entry: WorkspaceEntry): string {
  if (entry.child && !entry.workspace.name && entry.workspace.git?.branch) {
    return entry.workspace.git.branch.replace(/^worktree\//, "");
  }
  return workspaceLabel(entry.workspace);
}

interface WorkspaceBodyInput {
  workspaces: WorkspaceView[];
  status: (workspace: WorkspaceView) => AgentStatus;
  /** Workspace drawn as focused, if any. */
  focusedId: string | null;
  navigateId: string | null;
  collapsedGroups: Set<string> | undefined;
  /** Cached state of a machine that is not online: drawn dimmed. */
  stale: boolean;
  target: (workspace: WorkspaceView) => ClickTarget;
  groupToggles: boolean;
  indicators: "dots" | "symbols";
  width: number;
  sidebar: SidebarConfig;
}

/** Workspace rows (with branch detail lines) for one daemon's workspaces. */
function workspaceBodyRows(input: WorkspaceBodyInput): ChromeRow[] {
  const { width, sidebar } = input;
  const body: ChromeRow[] = [];
  const entries = workspaceEntries(
    input.workspaces,
    input.collapsedGroups,
    input.focusedId ?? "",
  );
  entries.forEach((entry, entryIndex) => {
    const workspace = entry.workspace;
    const focused = workspace.id === input.focusedId;
    const navigating = workspace.id === input.navigateId;
    const background = navigating
      ? theme.selection
      : focused
        ? theme.activeRow
        : undefined;
    const status = input.status(workspace);
    const target = input.target(workspace);
    const git = entry.child ? null : workspace.git;
    const rows = resolveRows(sidebar.spaces.rows, {
      state_icon: statusIcon(status, input.indicators),
      state_text: sidebarStatusText(status),
      workspace: entryLabel(entry),
      branch: git?.branch || null,
      git_status: git && !input.stale ? { ahead: git.ahead, behind: git.behind } : null,
      tokens: workspace.tokens ?? {},
    });
    const colors = input.stale
      ? {
        stateIcon: theme.muted,
        stateText: theme.muted,
        workspace: { color: theme.muted, bold: focused },
        secondary: theme.muted,
      }
      : {
        stateIcon: statusColor[status],
        stateText: statusColor[status],
        workspace: { color: focused ? theme.text : theme.subtext, bold: focused },
        secondary: focused ? theme.purple : theme.muted,
      };
    const toggle = entry.group && input.groupToggles ? entry.group : null;
    const firstPrefixWidth = entry.child ? 6 : 1;
    const firstContentWidth = width - firstPrefixWidth - (toggle ? 2 : 0) - 1;
    const leadingChip = rows[0]?.[0]?.kind === "state_icon" && firstContentWidth >= 8;
    rows.forEach((tokens, rowIndex) => {
      const prefix = rowIndex > 0
        ? " ".repeat(firstPrefixWidth + (leadingChip ? 4 : 2))
        : entry.child ? (entry.child.last ? "   └─ " : "   ├─ ") : " ";
      const reserve = rowIndex === 0 && toggle ? 2 : 0;
      const segments = entryTokenSegments(
        tokens,
        colors,
        Math.max(0, width - displayWidth(prefix) - reserve - 1),
        status,
        focused,
        input.stale,
      );
      const line: Segment[] = [
        { text: focused || navigating ? `▌${prefix.slice(1)}` : prefix,
          color: focused || navigating ? theme.brand : theme.muted },
        ...(input.stale ? segments.map((segment) => ({ ...segment, dim: true })) : segments),
      ];
      if (rowIndex === 0 && toggle) {
        const used = line.reduce((total, segment) => total + displayWidth(segment.text), 0);
        line.push({ text: " ".repeat(Math.max(0, width - 1 - used)) });
        line.push({
          text: toggle.collapsed ? "▸" : "▾",
          color: theme.brand,
          target: { kind: "group-toggle", repoKey: toggle.repoKey },
        });
      }
      body.push({ background, target, segments: fit(line, width) });
    });
    const next = entries[entryIndex + 1];
    if (next && !next.child) {
      for (let gap = 0; gap < sidebar.spaces.row_gap; gap += 1) body.push({ segments: [] });
    }
  });
  return body;
}

/** ` ▾ Label` with the connection state on the right (online shows only
 * its glyph; Local shows none). */
function machineRow(
  label: string,
  status: MachineStatus | null,
  collapsed: boolean,
  id: string,
  width: number,
): ChromeRow {
  const right: Segment[] = [];
  if (status !== null) {
    const presentation = machineStatusPresentation(status);
    const full = `${presentation.glyph} ${presentation.label}`;
    // Online shows only its glyph; others add their state when it fits
    // beside the label.
    const fits = displayWidth(label) + 3 + 1 + displayWidth(full) + 1 <= width;
    right.push({
      text: status === "online" || !fits ? presentation.glyph : full,
      color: presentation.color,
      backgroundColor: status === "online"
        ? statusBackground.idle
        : status === "attention" ? statusBackground.blocked : theme.surface0,
      bold: true,
    });
    right.push({ text: " " });
  }
  return {
    background: theme.surfaceDim,
    target: { kind: "machine", id },
    segments: rightAligned(
      [
        { text: " " },
        {
          text: collapsed ? "▸" : "▾",
          color: theme.brand,
          target: { kind: "machine-toggle", id },
        },
        { text: " " },
        {
          text: label,
          color: status === "disabled" ? theme.muted : theme.text,
          bold: true,
        },
      ],
      right,
      width,
    ),
  };
}

/** One row per screen line of the sidebar content (the divider column is
 * drawn separately). */
export function sidebarRows(state: StateView, options: SidebarOptions): ChromeRow[] {
  return options.compact ? compactRows(state, options) : expandedRows(state, options);
}

function expandedRows(state: StateView, options: SidebarOptions): ChromeRow[] {
  const width = Math.max(1, options.width - 1);
  const height = Math.max(0, options.height);
  if (height === 0) return [];
  const rows: ChromeRow[] = Array.from({ length: height }, () => ({ segments: [] }));
  const spacesHeight = height < 6
    ? Math.ceil(height / 2)
    : Math.max(3, Math.min(height - 3, Math.round(height * 0.5)));

  // Spaces section; with saved machines, Shepherd's machines variant: a row
  // per machine (Local first) with its workspaces nested under it.
  const sidebar = options.sidebar ?? defaultSidebarConfig();
  const machinesMode = state.machines.length > 0;
  rows[0] = {
    background: theme.surfaceRaised,
    segments: fit([
      { text: " ◆ ", color: theme.panelContrast, backgroundColor: theme.brand, bold: true },
      { text: "SHEPHERD", color: theme.text, backgroundColor: theme.surfaceRaised, bold: true },
    ], width),
  };
  rows[1] = {
    background: theme.surfaceDim,
    segments: rightAligned(
      [{ text: machinesMode ? " MACHINES" : " SPACES", color: theme.brand, bold: true }],
      [{ text: ` ${machinesMode ? state.machines.length + 1 : state.workspaces.length} `,
        color: theme.brand, backgroundColor: theme.activeRow, bold: true }],
      width,
    ),
  };
  const localBody = workspaceBodyRows({
    workspaces: state.workspaces,
    status: (workspace) => workspaceStatus(workspace, state.panes),
    focusedId: options.selectedRemote ? null : options.activeWorkspaceId,
    navigateId: options.navigateWorkspaceId,
    collapsedGroups: options.collapsedGroups,
    stale: false,
    target: (workspace) => ({ kind: "workspace", id: workspace.id }),
    groupToggles: true,
    sidebar,
    indicators: options.indicators,
    width,
  });
  let body: ChromeRow[] = localBody;
  if (machinesMode) {
    const collapsed = options.collapsedMachines ?? new Set<string>();
    body = [machineRow("Local", null, collapsed.has(LOCAL_MACHINE_ID), LOCAL_MACHINE_ID, width)];
    if (!collapsed.has(LOCAL_MACHINE_ID)) body.push(...localBody);
    for (const machine of state.machines) {
      const isCollapsed = collapsed.has(machine.id);
      body.push(machineRow(machine.label, machine.status, isCollapsed, machine.id, width));
      if (isCollapsed || !machine.remote) continue;
      body.push(...workspaceBodyRows({
        workspaces: machine.remote.workspaceList ?? [],
        status: (workspace) => remoteWorkspaceStatus(workspace, machine),
        focusedId: options.selectedRemote?.machineId === machine.id
          ? options.selectedRemote.workspaceId
          : null,
        navigateId: null,
        collapsedGroups: undefined,
        stale: machine.status !== "online",
        target: (workspace) => ({
          kind: "remote-workspace",
          machineId: machine.id,
          workspaceId: workspace.id,
        }),
        groupToggles: false,
        sidebar,
        indicators: options.indicators,
        width,
      }));
    }
  }
  const footerRow = spacesHeight - 1;
  const bodyStart = 2;
  const bodyRows = Math.max(0, footerRow - bodyStart);
  const selectedRemote = options.selectedRemote;
  const activeIndex = body.findIndex((row) =>
    selectedRemote
      ? row.target?.kind === "remote-workspace" &&
        row.target.machineId === selectedRemote.machineId &&
        row.target.workspaceId === selectedRemote.workspaceId
      : row.target?.kind === "workspace" && row.target.id === options.activeWorkspaceId
  );
  const offset = activeIndex >= bodyRows
    ? Math.min(activeIndex - bodyRows + 2, Math.max(0, body.length - bodyRows))
    : 0;
  for (let index = 0; index < bodyRows; index += 1) {
    const row = body[offset + index];
    if (row) rows[bodyStart + index] = row;
  }
  if (options.mouse && footerRow > 0) {
    rows[footerRow] = {
      segments: rightAligned(
        [{ text: " + new", color: theme.brand, bold: true, target: { kind: "new-workspace" } }],
        [{ text: "menu", color: theme.subtext, target: { kind: "menu" } }],
        width,
      ),
    };
  }

  // Agents section.
  const agentsTop = spacesHeight;
  if (agentsTop < height) {
    rows[agentsTop] = { segments: [{ text: "─".repeat(width), color: theme.surfaceDim }] };
  }
  const agents = agentEntries(state, options.sort);
  const grouped = normalizeAgentSort(options.sort) === "status" && !state.agentView?.sort.length;
  if (agentsTop + 1 < height) {
    rows[agentsTop + 1] = {
      background: theme.surfaceDim,
      segments: rightAligned(
        [
          { text: " AGENTS ", color: theme.brand, bold: true, target: { kind: "agent-sort" } },
          { text: String(agents.length), color: theme.brand, backgroundColor: theme.activeRow, bold: true,
            target: { kind: "agent-sort" } },
        ],
        [state.agentView
          ? { text: state.agentView.label ?? "view", color: theme.brand, bold: true }
          : {
            text: grouped ? "status" : "spaces",
            color: theme.subtext,
            bold: true,
            target: { kind: "agent-sort" },
          }],
        width,
      ),
    };
  }
  const agentRows: ChromeRow[] = [];
  const pushAgent = (entry: AgentEntry) => {
    const focused = entry.pane.id === options.focusedPaneId;
    const target: ClickTarget = { kind: "agent", paneId: entry.pane.id };
    const background = focused ? theme.activeRow : undefined;
    const pane = entry.pane;
    const showTab = entry.workspace.tabs.length > 1 || Boolean(entry.tab.name);
    const title = pane.terminalTitle || null;
    const tokenRows = resolveRows(
      sidebar.agents.rows_by_agent[pane.agent ?? ""] ?? sidebar.agents.rows,
      {
        state_icon: statusIcon(pane.status, options.indicators),
        state_text: pane.stateLabels?.[pane.status] ?? sidebarStatusText(pane.status),
        machine: null,
        workspace: workspaceLabel(entry.workspace),
        tab: showTab ? tabLabel(entry.tab, entry.tabIndex) : null,
        pane: pane.task?.title || pane.metadataTitle || pane.title || null,
        agent: pane.displayAgent || pane.agent || pane.metadataTitle || null,
        terminal_title: title,
        terminal_title_stripped: title ? stripTitleActivity(title) : null,
        tokens: pane.tokens ?? {},
      },
    );
    const colors = {
      stateIcon: statusColor[pane.status],
      stateText: statusColor[pane.status],
      workspace: { color: focused ? theme.text : theme.subtext, bold: true },
      secondary: focused ? theme.subtext : theme.muted,
    };
    const leadingChip = tokenRows[0]?.[0]?.kind === "state_icon" && width - 1 >= 8;
    (tokenRows.length > 0 ? tokenRows : [[{ kind: "state_icon" as const, text: statusIcon(pane.status, options.indicators), style: {} }]])
      .forEach((tokens, rowIndex) => {
        const indent = rowIndex === 0 ? " " : leadingChip ? "     " : "   ";
        agentRows.push({
          background,
          target,
          segments: fit([
            { text: focused ? `▌${indent.slice(1)}` : indent, color: theme.brand },
            ...entryTokenSegments(tokens, colors, width - indent.length, pane.status, focused),
          ], width),
        });
      });
  };
  if (grouped) {
    for (const lane of LANE_ORDER) {
      const group = agents.filter((entry) => deskLane(entry.pane) === lane);
      if (group.length === 0) continue;
      if (agentRows.length > 0) agentRows.push({ segments: [] });
      const status = laneStatus(lane);
      agentRows.push({
        background: statusBackground[status],
        segments: rightAligned(
          [{ text: ` ${laneGlyph(lane)} ${LANE_LABELS[lane]}`, color: laneColor(lane), bold: true }],
          [{ text: ` ${group.length} `, color: statusForeground[status], backgroundColor: statusColor[status], bold: true }],
          width,
        ),
      });
      group.forEach((entry, index) => {
        pushAgent(entry);
        if (index < group.length - 1) {
          for (let gap = 0; gap < sidebar.agents.row_gap; gap += 1) agentRows.push({ segments: [] });
        }
      });
    }
  } else {
    agents.forEach((entry, entryIndex) => {
      pushAgent(entry);
      if (entryIndex < agents.length - 1) {
        for (let gap = 0; gap < sidebar.agents.row_gap; gap += 1) agentRows.push({ segments: [] });
      }
    });
  }
  const agentsBody = agentsTop + 3;
  const visibleCapacity = Math.max(0, height - 1 - agentsBody);
  const overflowing = agentRows.length > visibleCapacity && visibleCapacity > 1;
  const capacity = overflowing ? visibleCapacity - 1 : visibleCapacity;
  const maxOffset = Math.max(0, agentRows.length - capacity);
  const focusedRow = agentRows.findIndex((row) => row.target?.kind === "agent" && row.target.paneId === options.focusedPaneId);
  const initialOffset = focusedRow >= capacity ? focusedRow : 0;
  const agentOffset = Math.max(0, Math.min(maxOffset, options.agentScroll ?? initialOffset));
  for (let index = 0; index < capacity; index += 1) {
    const row = agentRows[agentOffset + index];
    if (row) rows[agentsBody + index] = row;
  }
  if (overflowing) {
    rows[height - 2] = { segments: rightAligned(
      agentOffset > 0 ? [{ text: " ↑ prev", color: theme.brand, target: { kind: "agent-scroll", offset: Math.max(0, agentOffset - capacity) } }] : [],
      agentOffset < maxOffset ? [{ text: "next ↓ ", color: theme.brand, target: { kind: "agent-scroll", offset: Math.min(maxOffset, agentOffset + capacity) } }] : [],
      width,
    ) };
  }
  for (let index = agentsTop + 1; index < height - 1; index += 1) {
    rows[index]!.agentScroll = { offset: agentOffset, maxOffset };
  }
  // Collapse toggle in the bottom-right corner.
  if (height > 0) {
    const last = rows[height - 1] ?? { segments: [] };
    const used = last.segments.reduce((total, segment) => total + displayWidth(segment.text), 0);
    const toggleAt = Math.max(0, width - 2);
    if (used <= toggleAt) {
      rows[height - 1] = {
        ...last,
        segments: [
          ...last.segments,
          { text: " ".repeat(toggleAt - used) },
          { text: "«", color: theme.muted, target: { kind: "sidebar-toggle" } },
        ],
      };
    }
  }
  return rows.slice(0, height);
}

/** Shepherd's collapsed rail: numbered workspaces and agents with status
 * icons, and a » toggle on the bottom row. */
function compactRows(state: StateView, options: SidebarOptions): ChromeRow[] {
  const width = Math.max(1, options.width - 1);
  const height = Math.max(0, options.height);
  const rows: ChromeRow[] = Array.from({ length: height }, () => ({ segments: [] }));
  const split = height >= 7 ? Math.ceil(height / 2) : height - 1;
  const compactItems: ChromeRow[] = state.workspaces.map((workspace, index) => {
    const focused = workspace.id === options.activeWorkspaceId && !options.selectedRemote;
    const status = workspaceStatus(workspace, state.panes);
    return {
      background: focused ? theme.activeRow : undefined,
      target: { kind: "workspace", id: workspace.id },
      segments: [
        {
          text: String(index + 1).padEnd(2).slice(0, 2),
          color: focused ? theme.brand : theme.subtext,
          backgroundColor: focused ? theme.activeRow : undefined,
          bold: focused,
        },
        {
          text: statusIcon(status, options.indicators),
          color: focused ? statusForeground[status] : statusColor[status],
          backgroundColor: focused ? statusColor[status] : statusBackground[status],
          bold: true,
          animate: status === "working" && options.indicators === "symbols",
        },
      ],
    };
  });
  // Saved machines follow as `M<n>` with their connection glyph.
  state.machines.forEach((machine, index) => {
    const presentation = machineStatusPresentation(machine.status);
    const selected = options.selectedRemote?.machineId === machine.id;
    compactItems.push({
      background: selected ? theme.activeRow : undefined,
      target: { kind: "machine", id: machine.id },
      segments: [
        {
          text: `M${index + 1}`.slice(0, 2),
          color: selected ? theme.brand : theme.subtext,
          backgroundColor: selected ? theme.activeRow : undefined,
          bold: selected,
        },
        { text: presentation.glyph, color: presentation.color, bold: true },
      ],
    });
  });
  compactItems.slice(0, split).forEach((row, index) => {
    rows[index] = row;
  });
  if (height >= 7) {
    rows[split] = { segments: [{ text: "─".repeat(width), color: theme.surfaceDim }] };
    agentEntries(state, options.sort).slice(0, height - split - 2).forEach((entry, index) => {
      const focused = entry.pane.id === options.focusedPaneId;
      rows[split + 1 + index] = {
        background: focused ? theme.activeRow : undefined,
        target: { kind: "agent", paneId: entry.pane.id },
        segments: [
          {
            text: String(index + 1).padEnd(2).slice(0, 2),
            color: focused ? theme.brand : theme.subtext,
            backgroundColor: focused ? theme.activeRow : undefined,
            bold: focused,
          },
          {
            text: statusIcon(entry.pane.status, options.indicators),
            color: focused ? statusForeground[entry.pane.status] : statusColor[entry.pane.status],
            backgroundColor: focused ? statusColor[entry.pane.status] : statusBackground[entry.pane.status],
            bold: true,
            animate: entry.pane.status === "working" && options.indicators === "symbols",
          },
        ],
      };
    });
  }
  if (height > 0) {
    const pad = Math.floor(width / 2);
    rows[height - 1] = {
      segments: [
        { text: " ".repeat(pad) },
        { text: "»", color: theme.muted, target: { kind: "sidebar-toggle" } },
      ],
    };
  }
  return rows.slice(0, height).map((row) => ({ ...row, segments: fit(row.segments, width) }));
}

/** Target under column `x` of a row (x relative to the row start). */
export function targetAt(row: ChromeRow | undefined, x: number): ClickTarget | null {
  if (!row) return null;
  let cursor = 0;
  for (const segment of row.segments) {
    const width = displayWidth(segment.text);
    if (x >= cursor && x < cursor + width && segment.target) return segment.target;
    cursor += width;
  }
  return row.target ?? null;
}

export interface TabBarOptions {
  width: number;
  activeTabId: string;
  zoomedTabIds: Set<string>;
  mouse: boolean;
  /** First tab shown when the strip overflows. */
  scroll?: number;
  /** Status segments right-aligned after the tabs. */
  right?: Segment[];
}

const MIN_TAB_WIDTH = 8;

/** Shepherd's tab strip: centred labels at least 8 wide, a gap between tabs,
 * a " + " button, and " < " / " > " when the tabs overflow. */
export function tabBarRow(tabs: TabView[], options: TabBarOptions): ChromeRow {
  const items = tabs.map((tab, index) => {
    const zoom = options.zoomedTabIds.has(tab.id) ? " Z" : "";
    const label = `${tabLabel(tab, index)}${zoom}`;
    const width = Math.max(displayWidth(label) + 4, MIN_TAB_WIDTH);
    return { tab, label, width, custom: Boolean(tab.name) };
  });
  const plusWidth = options.mouse ? 3 : 0;
  const rightSegments = options.right ?? [];
  const rightWidth = rightSegments.reduce((sum, segment) => sum + displayWidth(segment.text), 0);
  // Status entries only show while at least 17 columns remain for tabs.
  const showRight = rightWidth > 0 && options.width - rightWidth - 1 >= 17;
  const stripWidth = showRight ? options.width - rightWidth - 1 : options.width;
  const total = items.reduce((sum, item) => sum + item.width + 1, 0) + plusWidth;
  const overflow = total > stripWidth && stripWidth >= MIN_TAB_WIDTH + 3 + 6;

  const tabSegments = (item: (typeof items)[number]): Segment[] => {
    const focused = item.tab.id === options.activeTabId;
    const padding = item.width - displayWidth(item.label);
    const left = Math.floor(padding / 2);
    const style = focused
      ? { color: theme.panelContrast, backgroundColor: theme.brand, bold: true }
      : { color: item.custom ? theme.subtext : theme.muted, backgroundColor: theme.surfaceDim };
    return [
      {
        text: `${" ".repeat(left)}${item.label}${" ".repeat(padding - left)}`,
        ...style,
        target: { kind: "tab", id: item.tab.id },
      },
      { text: " ", backgroundColor: theme.panelBg },
    ];
  };

  const segments: Segment[] = [];
  if (!overflow) {
    for (const item of items) segments.push(...tabSegments(item));
  } else {
    const available = stripWidth - 6 - plusWidth - 2;
    const activeIndex = Math.max(0, items.findIndex((item) => item.tab.id === options.activeTabId));
    // Centre the focused tab, then fill outwards.
    let first = activeIndex;
    let last = activeIndex;
    let used = (items[activeIndex]?.width ?? 0) + 1;
    while (true) {
      const canLeft = first > 0 && used + (items[first - 1]?.width ?? 0) + 1 <= available;
      const canRight = last < items.length - 1 && used + (items[last + 1]?.width ?? 0) + 1 <= available;
      if (!canLeft && !canRight) break;
      if (canRight && (!canLeft || last - activeIndex <= activeIndex - first)) {
        last += 1;
        used += (items[last]?.width ?? 0) + 1;
      } else {
        first -= 1;
        used += (items[first]?.width ?? 0) + 1;
      }
    }
    segments.push({
      text: " < ",
      color: first > 0 ? theme.brand : theme.muted,
      backgroundColor: theme.surface0,
      bold: first > 0,
      target: { kind: "tabs-left" },
    });
    segments.push({ text: first > 0 ? "…" : " ", color: theme.muted, backgroundColor: theme.panelBg });
    for (const item of items.slice(first, last + 1)) segments.push(...tabSegments(item));
    segments.push({ text: last < items.length - 1 ? "…" : " ", color: theme.muted, backgroundColor: theme.panelBg });
    segments.push({
      text: " > ",
      color: last < items.length - 1 ? theme.brand : theme.muted,
      backgroundColor: theme.surface0,
      bold: last < items.length - 1,
      target: { kind: "tabs-right" },
    });
  }
  if (options.mouse) {
    segments.push({
      text: " + ",
      color: theme.brand,
      backgroundColor: theme.surface0,
      bold: true,
      target: { kind: "new-tab" },
    });
  }
  const strip = fit(segments, stripWidth);
  const used = strip.reduce((sum, segment) => sum + displayWidth(segment.text), 0);
  const fill = (showRight ? options.width - rightWidth : options.width) - used;
  if (fill > 0) strip.push({ text: " ".repeat(fill), backgroundColor: theme.panelBg });
  if (showRight) strip.push(...rightSegments);
  return { segments: fit(strip, options.width), background: theme.panelBg };
}
