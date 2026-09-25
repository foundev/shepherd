export const PROTOCOL_VERSION = 1;

export type SplitDirection = "right" | "down";
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type ReadSource = "visible" | "recent" | "recent-unwrapped";

/** Evidence for a status. A quiet terminal alone is never proof of completion. */
export interface AgentSignal {
  source: "integration" | "screen" | "process" | "none";
  confidence: "reported" | "inferred" | "unknown";
  reason: string;
  observedAt: number;
  changedAt?: number;
  expiresAt: number | null;
}

export interface AgentTaskPatch {
  title?: string;
  summary?: string;
  nextAction?: string;
  blocker?: string;
  checkStatus?: "unknown" | "running" | "passed" | "failed";
  checkSummary?: string;
  review?: "none" | "requested" | "reviewed";
}

export interface AgentTask extends Required<AgentTaskPatch> {
  revision: number;
  updatedAt: number;
  source: string;
  reviewRequestedAt: number | null;
  activity: Array<{ at: number; text: string; source: string }>;
}

export interface TaskChanges {
  files: Array<{ path: string; status: string; from?: string }>;
  total: number;
}

export interface TerminalSpan {
  text: string;
  /** Host ANSI palette name, explicit RGB hex, or undefined for the default. */
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  italic?: boolean;
  dimColor?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strikethrough?: boolean;
}

export type TerminalLine = TerminalSpan[];

export interface CursorView {
  x: number;
  y: number;
  visible: boolean;
  shape: "block" | "underline" | "bar";
  blink: boolean;
}

/** Pushed to clients that subscribed to a pane's surface. `lines` holds only
 * rows that changed since the previous frame unless `full` is set. */
export interface SurfaceFrame {
  paneId: string;
  revision: number;
  cols: number;
  rows: number;
  full: boolean;
  lines: Record<number, TerminalLine>;
  cursor: CursorView;
  title: string;
  scroll: { offsetFromBottom: number; maxOffsetFromBottom: number };
  modes: PaneModesView;
}

export interface PaneModesView {
  applicationCursorKeys: boolean;
  bracketedPaste: boolean;
  mouseTracking: "none" | "x10" | "vt200" | "drag" | "any";
  sendFocus: boolean;
  alternateScreen: boolean;
  kittyKeyboard?: number;
  modifyOtherKeys?: number;
}

export interface SurfaceInterest {
  paneId: string;
  cols: number;
  rows: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LayoutNode =
  | { kind: "pane"; paneId: string }
  | {
      kind: "split";
      direction: SplitDirection;
      ratio: number;
      first: LayoutNode;
      second: LayoutNode;
    };

export interface PaneView {
  id: string;
  title: string;
  command: string | null;
  cwd: string;
  agent: string | null;
  status: AgentStatus;
  exitCode: number | null;
  updatedAt: string;
  terminalTitle?: string;
  signal?: AgentSignal;
  task?: AgentTask | null;
  continuity?: "live" | "restarted" | "resuming" | "handoff";
  /** Reported metadata (pane.report_metadata). */
  metadataTitle?: string | null;
  displayAgent?: string | null;
  stateLabels?: Record<string, string>;
  tokens?: Record<string, string>;
  modes?: {
    applicationCursorKeys: boolean;
    bracketedPaste: boolean;
    mouseTracking: "none" | "x10" | "vt200" | "drag" | "any";
    sendFocus: boolean;
    alternateScreen: boolean;
    kittyKeyboard?: number;
    modifyOtherKeys?: number;
  };
}

export interface TabView {
  id: string;
  /** Custom name, or "" to show the tab's 1-based index. */
  name: string;
  layout: LayoutNode;
  zoomedPaneId?: string | null;
}

export interface WorkspaceView {
  id: string;
  /** Custom name, or "" when the workspace uses its derived label. */
  name: string;
  /** Display label: custom name, else Git repository, else directory. */
  label?: string;
  rootPath: string;
  tabs: TabView[];
  activeTabId: string;
  git?: GitStatusView | null;
  tokens?: Record<string, string>;
}

/** A filtered, sorted view of the agents list (agent.view.set). */
export interface AgentViewSpec {
  source: string;
  label: string | null;
  filter: unknown;
  sort: Array<{ field: unknown; order?: "asc" | "desc" }>;
}

export interface GitStatusView {
  repoName: string;
  repoKey: string;
  repoRoot: string;
  linked: boolean;
  checkoutPath: string;
  branch: string | null;
  ahead: number;
  behind: number;
}

export interface PluginActionView {
  id: string;
  title: string;
  command: string[];
  description?: string;
  /** Where the action makes sense: global, workspace, tab, pane, selection. */
  contexts?: string[];
  platforms?: string[];
}

export interface PluginCommandEntryView {
  command: string[];
  platforms?: string[];
}

export interface PluginEventHookView extends PluginCommandEntryView {
  on: string[];
}

export interface PluginPaneEntrypointView {
  id: string;
  title: string;
  description?: string;
  placement: "overlay" | "popup" | "split" | "tab" | "zoomed";
  width?: number | string;
  height?: number | string;
  command: string[];
  platforms?: string[];
}

export interface PluginLinkHandlerView {
  id: string;
  title: string;
  pattern: string;
  action: string;
  platforms?: string[];
}

export interface PluginView {
  id: string;
  name: string;
  version: string;
  description?: string;
  minShepherdVersion?: string;
  platforms?: string[];
  manifestPath: string;
  root: string;
  enabled: boolean;
  /** Installed from GitHub into Shepherd's managed plugin directory. */
  managed?: boolean;
  actions: PluginActionView[];
  builds?: PluginCommandEntryView[];
  startup?: PluginCommandEntryView[];
  events?: PluginEventHookView[];
  panes?: PluginPaneEntrypointView[];
  linkHandlers?: PluginLinkHandlerView[];
  warnings?: string[];
  configDir?: string;
}

/** One plugin command run (action, startup hook, event hook, or pane). */
export interface PluginCommandLogView {
  logId: string;
  pluginId: string;
  kind: "action" | "startup" | "event" | "pane";
  actionId?: string;
  event?: string;
  entrypointId?: string;
  command: string[];
  status: "running" | "succeeded" | "failed";
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

export interface RemoteAgentSummary {
  paneId: string;
  agent: string;
  status: AgentStatus;
  title: string;
}

export interface RemotePaneSummary {
  paneId: string;
  title: string;
  agent: string | null;
  status: AgentStatus;
  cwd?: string;
  updatedAt?: string;
  signal?: AgentSignal;
  task?: AgentTask | null;
  continuity?: PaneView["continuity"];
}

/** Connection state of a saved machine's persistent bridge (Shepherd's
 * endpoint states, plus `idle` for a bridge closed while nothing uses it). */
export type MachineStatus =
  | "online"
  | "connecting"
  | "reconnecting"
  | "attention"
  | "disabled"
  | "idle";

export interface RemoteMachineView {
  id: string;
  label: string;
  target: string;
  port: number;
  checkedAt: string | null;
  reachable: boolean;
  error: string | null;
  status: MachineStatus;
  enabled: boolean;
  remoteSession: string | null;
  /** Last state read from the machine. Kept while reconnecting, when it is
   * cached rather than live. */
  remote: {
    serverPid: number;
    protocolVersion: number;
    workspaces: number;
    tabs: number;
    paneCount: number;
    panes: RemotePaneSummary[];
    agents: RemoteAgentSummary[];
    workspaceList: WorkspaceView[];
    activeWorkspaceId: string;
  } | null;
}

export interface StateView {
  /** Active agent view, if a client or script set one. */
  agentView?: AgentViewSpec | null;
  protocolVersion: number;
  session: string;
  serverPid: number;
  clientId?: string;
  /** Tabs in the active workspace. Kept for v1 clients. */
  tabs: TabView[];
  workspaces: WorkspaceView[];
  activeWorkspaceId: string;
  activeTabId: string;
  focusedPaneId: string;
  panes: PaneView[];
  plugins: PluginView[];
  machines: RemoteMachineView[];
  stateVersion: number;
}

export interface RemoteAgentOperationResult {
  machineId: string;
  machineLabel: string;
  paneId: string;
  kind: "get" | "read" | "prompt" | "wait";
  value: string;
  exitCode: number | null;
}

export interface WorktreeView {
  path: string;
  branch: string | null;
  commit: string;
  bare: boolean;
  detached: boolean;
}

export type ShepherdRequest =
  | { type: "hello" }
  | { type: "ping" }
  | { type: "state.get" }
  | { type: "agent.manifests" }
  | { type: "agent.list" }
  | { type: "agent.get"; target: string }
  | { type: "agent.explain"; target: string }
  | { type: "task.get"; paneId: string }
  | { type: "task.changes"; paneId: string }
  | { type: "task.update"; paneId: string; patch: AgentTaskPatch; source?: string; expectedRevision?: number }
  | { type: "agent.send"; paneId: string; text: string }
  | { type: "server.live_handoff" }
  | {
      type: "pane.report_agent";
      paneId: string;
      source: string;
      agent: string;
      state: "idle" | "working" | "blocked" | "unknown";
      ttlMs?: number;
    }
  | { type: "pane.release_agent"; paneId: string; source?: string }
  | { type: "pane.link_at"; paneId: string; line: number; col: number }
  | { type: "integration.list" }
  | { type: "integration.install"; target: string }
  | { type: "integration.uninstall"; target: string }
  | {
      type: "pane.report_agent_session";
      paneId: string;
      source: string;
      agent: string;
      sessionId: string;
    }
  | { type: "agent.read"; target: string; rows?: number }
  | { type: "marketplace.refresh" }
  | { type: "worktree.list"; root?: string; workspaceId?: string }
  | {
      type: "worktree.create";
      /** Repository to add the worktree to; defaults to the workspace's. */
      root?: string;
      workspaceId?: string;
      /** Defaults to <worktrees.directory>/<repo>/<branch-slug>. */
      path?: string;
      branch: string;
      createBranch?: boolean;
      /** Shepherd's name for startPoint. */
      base?: string;
      startPoint?: string;
      /** Open the new worktree as a workspace (Shepherd's behaviour). */
      open?: boolean;
      focus?: boolean;
    }
  | {
      type: "worktree.open";
      path: string;
      name?: string;
    }
  | {
      type: "worktree.remove";
      root?: string;
      path?: string;
      /** Remove this workspace's worktree and close the workspace. */
      workspaceId?: string;
      force?: boolean;
    }
  | { type: "tab.create"; name?: string }
  | { type: "tab.select"; tabId: string }
  | { type: "tab.close"; tabId: string }
  | { type: "tab.rename"; tabId: string; name: string }
  | { type: "tab.list" }
  | { type: "tab.focus"; tabId: string }
  | { type: "workspace.create"; name?: string }
  | { type: "workspace.select"; workspaceId: string }
  | { type: "workspace.close"; workspaceId: string }
  | { type: "workspace.rename"; workspaceId: string; name: string }
  | { type: "workspace.list" }
  | { type: "workspace.get"; workspaceId: string }
  | { type: "workspace.focus"; workspaceId: string }
  | {
      type: "pane.create";
      direction?: SplitDirection;
      command?: string;
      cwd?: string;
      title?: string;
      focus?: boolean;
    }
  | { type: "pane.focus"; paneId: string }
  | { type: "pane.rename"; paneId: string; title: string }
  | { type: "pane.zoom"; paneId: string; zoomed?: boolean }
  | {
      type: "pane.swap";
      paneId?: string;
      targetPaneId?: string;
      direction?: "left" | "right" | "up" | "down";
    }
  | {
      type: "pane.focus_direction";
      direction: "left" | "right" | "up" | "down";
      paneId?: string;
    }
  | {
      type: "pane.neighbor";
      direction: "left" | "right" | "up" | "down";
      paneId?: string;
    }
  | { type: "pane.move"; paneId: string; targetTabId: string }
  | { type: "client.window_title"; title: string | null }
  | {
      type: "pane.report_metadata";
      paneId: string;
      source: string;
      title?: string | null;
      clearTitle?: boolean;
      displayAgent?: string | null;
      clearDisplayAgent?: boolean;
      stateLabels?: Record<string, string>;
      clearStateLabels?: boolean;
      tokens?: Record<string, string | null>;
      ttlMs?: number;
      seq?: number;
    }
  | {
      type: "workspace.report_metadata";
      workspaceId: string;
      source: string;
      tokens: Record<string, string | null>;
      ttlMs?: number;
      seq?: number;
    }
  | { type: "agent.view.set"; view: AgentViewSpec }
  | { type: "agent.view.clear"; source?: string }
  | {
      type: "pane.move_new";
      paneId: string;
      destination: "tab" | "workspace";
      workspaceId?: string;
      label?: string;
      tabLabel?: string;
    }
  | { type: "pane.resize-layout"; paneId: string; delta: number }
  | { type: "pane.input"; paneId: string; data: string }
  | { type: "pane.paste"; paneId: string; text: string }
  | { type: "surface.subscribe"; panes: SurfaceInterest[] }
  | { type: "surface.scroll"; paneId: string; lines: number }
  | { type: "server.reload_config" }
  | {
      type: "notification.show";
      title: string;
      body?: string;
      position?: string;
      sound?: "none" | "done" | "request";
    }
  | {
      type: "command.run";
      command: string;
      commandType: "shell" | "pane" | "popup";
    }
  | { type: "popup.close"; paneId?: string }
  | { type: "pane.edit_scrollback"; paneId: string }
  | { type: "surface.scroll_to"; paneId: string; top: number | null }
  | { type: "pane.text"; paneId: string; start: number; count: number }
  | {
      type: "pane.search";
      paneId: string;
      query: string;
      line: number;
      col: number;
      direction: "forward" | "backward";
    }
  | { type: "tab.move"; tabId: string; insertIndex: number }
  | { type: "workspace.move"; workspaceId: string; insertIndex: number }
  | { type: "pane.clear"; paneId: string }
  | { type: "pane.focus-report"; paneId: string; focused: boolean }
  | {
      type: "pane.mouse";
      paneId: string;
      col: number;
      row: number;
      button: "left" | "middle" | "right" | "none" | "wheel";
      action: "press" | "release" | "move" | "drag" | "up" | "down";
      ctrl?: boolean;
      alt?: boolean;
      shift?: boolean;
    }
  | {
      type: "pane.resize";
      paneId?: string;
      cols?: number;
      rows?: number;
      /** expanded: move the border in this direction. */
      direction?: "left" | "right" | "up" | "down";
      amount?: number;
    }
  | { type: "pane.scroll"; paneId: string; lines: number }
  | { type: "pane.close"; paneId: string }
  | { type: "pane.list" }
  | { type: "pane.current" }
  | { type: "pane.get"; paneId: string }
  | {
      type: "pane.split";
      direction?: SplitDirection;
      command?: string;
      cwd?: string;
      title?: string;
    }
  | {
      type: "pane.read";
      paneId: string;
      rows?: number;
      source?: ReadSource;
    }
  | { type: "pane.send_text"; paneId: string; text: string }
  | { type: "pane.send_keys"; paneId: string; keys: string }
  | { type: "clipboard.write"; text: string }
  | { type: "layout.export"; tabId?: string }
  | { type: "layout.apply"; tabId?: string; layout: LayoutNode }
  | {
      type: "pane.snapshot";
      paneId: string;
      rows: number;
      source?: ReadSource;
    }
  | {
      type: "pane.wait";
      paneId: string;
      statuses: AgentStatus[];
      timeoutMs?: number;
    }
  | { type: "server.stop" }
  | { type: "plugin.link"; path: string }
  | { type: "plugin.unlink"; pluginId: string }
  | { type: "plugin.set-enabled"; pluginId: string; enabled: boolean }
  | {
      type: "plugin.action-invoke";
      pluginId: string;
      actionId: string;
      /** Extra invocation context merged into SHEPHERD_PLUGIN_CONTEXT_JSON. */
      context?: Record<string, unknown>;
    }
  | { type: "plugin.uninstall"; pluginId: string }
  | { type: "plugin.config-dir"; pluginId: string }
  | { type: "plugin.log-list"; pluginId?: string; limit?: number }
  | {
      type: "plugin.pane-open";
      pluginId: string;
      entrypointId: string;
      placement?: "overlay" | "popup" | "split" | "tab" | "zoomed";
      width?: number | string;
      height?: number | string;
      workspaceId?: string;
      targetPaneId?: string;
      direction?: SplitDirection;
      cwd?: string;
      focus?: boolean;
      env?: Record<string, string>;
    }
  | { type: "plugin.pane-focus"; paneId: string }
  | { type: "plugin.pane-close"; paneId: string }
  | { type: "plugin.link-open"; url: string; paneId?: string }
  | { type: "machine.refresh"; labelOrId: string }
  | { type: "machine.agent-get"; labelOrId: string; target: string }
  | {
      type: "machine.pane-read";
      labelOrId: string;
      paneId: string;
      rows?: number;
      source?: ReadSource;
    }
  | {
      type: "machine.pane-input";
      labelOrId: string;
      paneId: string;
      data: string;
      /** Send `data` exactly; otherwise a carriage return is appended. */
      raw?: boolean;
    }
  | {
      type: "machine.request";
      labelOrId: string;
      /** Any request for the machine's daemon, sent over its bridge. */
      request: Record<string, unknown>;
      timeoutMs?: number;
    }
  | { type: "machine.sync" }
  | { type: "config.keymap" }
  | {
      type: "machine.agent-read";
      labelOrId: string;
      target: string;
      rows?: number;
      source?: ReadSource;
    }
  | {
      type: "machine.agent-prompt";
      labelOrId: string;
      target: string;
      prompt: string;
      timeoutMs?: number;
    }
  | { type: "events.subscribe" }
  | { type: "events.unsubscribe" }
  | {
      type: "events.wait";
      event?: string;
      timeoutMs?: number;
    }

export type ShepherdResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string; code: string };

export interface EventFrame {
  event: string;
  data: Record<string, unknown>;
  emittedAt: string;
}

export type WireMessage =
  | ({ id: string } & ShepherdRequest)
  | ShepherdResponse
  | EventFrame;
