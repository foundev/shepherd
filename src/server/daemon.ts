import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import type {
  LayoutNode,
  PaneView,
  ShepherdRequest,
  SplitDirection,
  AgentStatus,
  StateView,
  TabView,
  WireMessage,
  WorkspaceView,
  PluginView,
  EventFrame,
  RemoteMachineView,
  WorktreeView,
  GitStatusView,
  AgentViewSpec,
} from "../types.js";
import { decodeStream, encodeMessage } from "../protocol.js";
import {
  layoutGeometry,
  paneIds,
  paneInDirection,
  paneLayout,
  removePane,
  resizeInDirection,
  resizePaneRatio,
  splitPane,
  swapPaneIds,
} from "./layout.js";
import {
  layoutFingerprint,
  loadHistory,
  loadState,
  removeHistory,
  saveHistory,
  saveState,
  stateDirectory,
} from "./persistence.js";
import {
  assertPluginCompatible,
  ensurePluginDirectories,
  loadPluginManifest,
  loadPluginRegistry,
  matchLinkHandler,
  DIRECT_HOOK_EVENTS,
  pluginConfigDirectory,
  pluginEnvironment,
  PluginLogStore,
  pluginStateDirectory,
  runPluginCommand,
  savePluginRegistry,
  shellCommandLine,
  supportsPlatform,
  type PluginCommandKind,
  type PluginCommandLog,
  type PluginCommandResult,
  type PluginInvocationContext,
  type PluginManifest,
  type PluginPanePlacement,
  type PluginPaneSize,
  type PluginRuntime,
} from "./plugins.js";
import { managedCheckoutFor } from "./pluginInstall.js";
import { PluginLifecycleTracker } from "./pluginLifecycle.js";
import { configuredShell, PaneTerminal } from "./terminal.js";
import os from "node:os";
import { spawn } from "node:child_process";
import { SurfaceSubscription } from "./surfaces.js";
import { MetadataStore } from "./metadata.js";
import { resumeArgv, shellCommand } from "./agentSessions.js";
import { updateTask } from "./tasks.js";
import { taskChanges } from "./taskChanges.js";
import { validateHookReport } from "./detection/detector.js";
import {
  installIntegration,
  listIntegrations,
  uninstallIntegration,
} from "./integrations.js";
import { AGENTS, detectAgentFromCommand, manifestFor } from "./detection/agents.js";
import { evaluate, explain } from "./detection/engine.js";
import { foregroundProcess, processTable, unwrapCommand } from "./processes.js";
import { loadConfig } from "../config/model.js";
import {
  branchExists,
  branchSlug,
  createWorktree,
  discoverRepository,
  gitStatus,
  listWorktrees,
  removeWorktree,
} from "./git.js";
import { writeClipboardText } from "./clipboard.js";
import { loadMachines } from "../machines.js";
import {
  saveMarketplaceCache,
  searchPluginMarketplace,
} from "./pluginMarketplace.js";
import {
  MachineManager,
  operationResult,
  remoteAgentGet,
  remoteAgentPrompt,
  remoteAgentRead,
  remotePaneRead,
} from "./machineBridge.js";
import { machinesPath } from "../machines.js";

interface RunningTab {
  id: string;
  name: string;
  layout: LayoutNode;
  rootPaneId?: string;
  focusedPaneId: string;
  zoomedPaneId: string | null;
  /** Most recent first; used to return focus when a pane closes. */
  focusHistory?: string[];
}

interface RunningWorkspace {
  id: string;
  name: string;
  rootPath: string;
  tabs: RunningTab[];
  activeTabId: string;
}

interface ClientState {
  id: string;
  socket: net.Socket;
  subscribed: boolean;
  surfaces: Map<string, SurfaceSubscription>;
  /** Whether the client's terminal window has focus (focus reports). */
  hostFocused: boolean;
  selection: {
    workspaceId: string;
    tabId: string;
    focusedPaneId: string;
  } | null;
}

/** A pane opened from a plugin `[[panes]]` entrypoint. */
interface PluginPaneRecord {
  pluginId: string;
  entrypointId: string;
  placement: PluginPanePlacement;
  log: PluginCommandLog;
  /** Overlay panes put back the tab's focus and zoom when they close. */
  restore?: { tabId: string; focusedPaneId: string; zoomedPaneId: string | null };
}

/** Plugin commands running at once; more are refused and logged. */
const MAX_PLUGIN_COMMANDS_IN_FLIGHT = 32;
const PLUGIN_ACTION_TIMEOUT_MS = 30_000;
const PLUGIN_HOOK_TIMEOUT_MS = 5 * 60_000;

interface EventWaiter {
  event?: string;
  resolve: (frame: EventFrame) => void;
  timer: NodeJS.Timeout;
}

export interface DaemonOptions {
  session: string;
  socketPath: string;
}

export class ShepherdDaemon {
  private readonly session: string;
  private readonly socketPath: string;
  private readonly panes = new Map<string, PaneTerminal>();
  private readonly plugins = new Map<string, {
    manifest: PluginManifest;
    enabled: boolean;
  }>();
  private readonly machines = new MachineManager({
    changed: () => {
      if (!this.stopping) this.changed();
    },
    manageSshConfig: () => this.config.remote.manage_ssh_config,
  });
  private watchingMachines = false;
  private readonly pluginLogs = new PluginLogStore();
  private pluginCommandsInFlight = 0;
  private readonly pluginPanes = new Map<string, PluginPaneRecord>();
  /** Diffs session state into lifecycle events for `[[events]]` hooks;
   * null while no enabled plugin has hooks. */
  private hookTracker: PluginLifecycleTracker | null = null;
  private hookPollScheduled = false;
  private workspaces: RunningWorkspace[] = [];
  private activeWorkspaceId = "";
  private activeTabId = "";
  private focusedPaneId = "";
  private stateVersion = 1;
  private nextClientId = 1;
  private nextPane = 1;
  private nextTab = 1;
  private nextWorkspace = 1;
  private saveTimer: NodeJS.Timeout | null = null;
  private agentStatusTimer: NodeJS.Timeout | null = null;
  private readonly agentStatuses = new Map<string, AgentStatus>();
  private readonly agentCompletions = new Map<string, number>();
  private marketplaceTimer: NodeJS.Timeout | null = null;
  private readonly clients = new Set<ClientState>();
  private readonly eventWaiters = new Set<EventWaiter>();
  private server?: net.Server;
  private stopping = false;
  private surfaceTimer: NodeJS.Timeout | null = null;
  private lastPersisted = "";
  /** When pane history was last written (0 = never, -1 = removed). */
  private historySavedAt = 0;
  private historyRevision = -1;
  private readonly workspaceMetadata = new Map<string, MetadataStore>();
  private agentView: AgentViewSpec | null = null;
  /** Outer window title set over the API, overriding ui.window_title. */
  private windowTitleOverride: string | null = null;
  private handingOff = false;
  /** Popup pane → client that opened it. */
  private readonly popups = new Map<string, string>();
  private gitTimer: NodeJS.Timeout | null = null;
  private processTimer: NodeJS.Timeout | null = null;
  private detectingAgents = false;
  private readonly gitStatuses = new Map<string, GitStatusView | null>();
  private refreshingGit = false;
  private gitRefreshPending = false;
  private config = loadConfig().config;
  private lastSurfaceFlush = 0;

  constructor(options: DaemonOptions) {
    this.session = options.session;
    this.socketPath = options.socketPath;
  }

  async start(): Promise<void> {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    fs.mkdirSync(stateDirectory(this.session), { recursive: true });
    this.restorePlugins();
    const handoffFile = process.env.SHEPHERD_HANDOFF_FILE;
    delete process.env.SHEPHERD_HANDOFF_FILE;
    if (!(handoffFile && this.restoreFromHandoff(handoffFile))) this.restore();
    this.syncSavedMachines();
    this.watchSavedMachines();
    if (this.workspaces.length === 0) this.createWorkspace("");

    await this.listen();
    if (this.hasEventHooks()) this.hookTracker = new PluginLifecycleTracker(this.stateView());
    // Startup hooks run once the socket is ready, including in the daemon
    // that takes over during a live handoff.
    this.runStartupHooks();

    process.on("SIGINT", () => void this.stop());
    process.on("SIGTERM", () => void this.stop());
    this.saveTimer = setInterval(() => {
      this.persist();
      this.persistHistory();
      this.pruneMetadata();
    }, 2_000);
    this.saveTimer.unref?.();
    for (const [id, pane] of this.panes) {
      this.agentStatuses.set(id, pane.status);
    }
    this.scheduleDetection();
    void this.refreshGitStatus();
    this.gitTimer = setInterval(() => void this.refreshGitStatus(), 5_000);
    this.gitTimer.unref?.();
    this.processTimer = setInterval(() => {
      for (const pane of this.panes.values()) void pane.refreshCwd();
      void this.detectForegroundAgents();
    }, 1_000);
    this.processTimer.unref?.();
    const configuredInterval = Number.parseInt(
      process.env.SHEPHERD_MARKETPLACE_REFRESH_MS ?? "1800000",
      10,
    );
    const marketplaceInterval = Number.isFinite(configuredInterval)
      ? configuredInterval
      : 1_800_000;
    if (marketplaceInterval > 0) {
      this.marketplaceTimer = setInterval(() => {
        void this.refreshMarketplace();
      }, marketplaceInterval);
      this.marketplaceTimer.unref?.();
    }
  }

  private listen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => this.acceptClient(socket));
      server.on("error", reject);
      server.listen(this.socketPath, () => {
        this.server = server;
        if (process.platform !== "win32") {
          fs.chmodSync(this.socketPath, 0o600);
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const waiter of this.eventWaiters) {
      clearTimeout(waiter.timer);
    }
    this.eventWaiters.clear();
    this.hookTracker = null;
    this.persist();
    this.persistHistory(true);
    for (const pane of this.panes.values()) pane.close();
    if (this.saveTimer) clearInterval(this.saveTimer);
    if (this.agentStatusTimer) clearTimeout(this.agentStatusTimer);
    if (this.marketplaceTimer) clearInterval(this.marketplaceTimer);
    if (this.surfaceTimer) clearTimeout(this.surfaceTimer);
    if (this.gitTimer) clearInterval(this.gitTimer);
    if (this.processTimer) clearInterval(this.processTimer);
    this.machines.stop();
    if (this.watchingMachines) fs.unwatchFile(machinesPath());

    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      // close() waits for open connections; attached clients would keep the
      // daemon alive forever.
      for (const client of this.clients) client.socket.destroy();
    });

    if (process.platform !== "win32") {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        // Another shutdown handler may already have removed the socket.
      }
    }
  }

  private acceptClient(socket: net.Socket): void {
    if (this.handingOff) {
      socket.destroy();
      return;
    }
    const client: ClientState = {
      id: `c${this.nextClientId}`,
      socket,
      subscribed: false,
      surfaces: new Map(),
      hostFocused: true,
      selection: null,
    };
    this.nextClientId += 1;
    this.clients.add(client);
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const { messages, remainder } = decodeStream(buffer);
      buffer = remainder;
      for (const message of messages) {
        void this.handleMessage(client, message).catch((error: unknown) => {
          const id = "id" in message ? message.id : "";
          if (!id) return;
          socket.write(encodeMessage({
            id,
            ok: false,
            code: "internal_error",
            error: error instanceof Error ? error.message : String(error),
          }));
        });
      }
    });
    socket.on("close", () => {
      this.clients.delete(client);
      this.updateMachineDemand();
    });
  }

  private async handleMessage(
    client: ClientState,
    message: WireMessage,
  ): Promise<void> {
    if (!message || typeof message !== "object" || !("id" in message)) return;
    if (!("type" in message) || typeof message.type !== "string") {
      client.socket.write(encodeMessage({
        id: message.id,
        ok: false,
        code: "invalid_request",
        error: 'Shepherd requests require a "type" field and top-level parameters; run shepherd api schema for the supported requests',
      }));
      return;
    }
    const request = message as { id: string } & ShepherdRequest;
    const { id } = request;
    try {
      const alias = await this.dispatchRequestAliases(
        client,
        message as Record<string, unknown>,
      );
      const result = alias.handled
        ? alias.result
        : await this.dispatch(client, request);
      client.socket.write(encodeMessage({ id, ok: true, result }));
    } catch (error) {
      client.socket.write(encodeMessage({
        id,
        ok: false,
        code: "request_failed",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private async dispatchRequestAliases(
    client: ClientState,
    message: Record<string, unknown>,
  ): Promise<{ handled: false } | { handled: true; result: unknown }> {
    const type = typeof message.type === "string" ? message.type : "";
    switch (type) {
      case "ping":
        return {
          handled: true,
          result: {
            product: "shepherd",
            protocolVersion: 1,
            version: "0.1.0",
          },
        };
      case "workspace.list": {
        const state = this.stateViewForClient(client);
        return { handled: true, result: state.workspaces };
      }
      case "workspace.get": {
        const workspaceId = requiredAliasString(message.workspaceId);
        const state = this.stateViewForClient(client);
        const workspace = state.workspaces.find((entry) =>
          entry.id === workspaceId
        );
        if (!workspace) throw new Error(`unknown workspace: ${workspaceId}`);
        return { handled: true, result: workspace };
      }
      case "workspace.create":
        this.createWorkspace(
          optionalAliasString(message.name) ?? "",
          this.newPaneCwd(client),
        );
        this.selectWorkspaceForClient(
          client,
          this.workspaces[this.workspaces.length - 1],
        );
        this.changed();
        return { handled: true, result: this.stateViewForClient(client) };
      case "workspace.focus": {
        const workspaceId = requiredAliasString(message.workspaceId);
        this.selectWorkspaceForClient(
          client,
          this.requireWorkspace(workspaceId),
        );
        this.changed();
        return { handled: true, result: this.stateViewForClient(client) };
      }
      case "tab.list":
        return { handled: true, result: this.stateViewForClient(client).tabs };
      case "tab.create":
        this.createTab(
          optionalAliasString(message.name) ?? "",
          client,
        );
        return { handled: true, result: this.stateViewForClient(client) };
      case "tab.focus": {
        const tabId = requiredAliasString(message.tabId);
        const tab = this.requireTab(tabId);
        this.selectTabForClient(
          client,
          this.requireWorkspaceByTab(tab.id),
          tab,
        );
        this.changed();
        return { handled: true, result: this.stateViewForClient(client) };
      }
      case "pane.list":
        return { handled: true, result: this.stateViewForClient(client).panes };
      case "pane.current": {
        const state = this.stateViewForClient(client);
        const pane = state.panes.find((entry) =>
          entry.id === state.focusedPaneId
        );
        if (!pane) throw new Error("no current pane");
        return { handled: true, result: pane };
      }
      case "pane.get": {
        const paneId = requiredAliasString(message.paneId);
        const pane = this.stateViewForClient(client).panes.find((entry) =>
          entry.id === paneId
        );
        if (!pane) throw new Error(`unknown pane: ${paneId}`);
        return { handled: true, result: pane };
      }
      case "pane.split":
        return {
          handled: true,
          result: this.createPane({
            direction: optionalAliasString(message.direction) === "down"
              ? "down"
              : "right",
            command: optionalAliasString(message.command),
            cwd: optionalAliasString(message.cwd),
            title: optionalAliasString(message.title),
          }, client),
        };
      case "layout.export": {
        const tabId = optionalAliasString(message.tabId);
        const tab = tabId
          ? this.requireTab(tabId)
          : this.activeTabForClient(client);
        return {
          handled: true,
          result: {
            tabId: tab.id,
            layout: tab.layout,
            paneIds: paneIds(tab.layout),
          },
        };
      }
      case "layout.apply": {
        const tabId = optionalAliasString(message.tabId);
        const layout = requiredAliasLayout(message.layout);
        const tab = tabId
          ? this.requireTab(tabId)
          : this.activeTabForClient(client);
        const existing = new Set(paneIds(tab.layout));
        const incoming = paneIds(layout);
        if (incoming.length === 0) throw new Error("layout has no panes");
        if (new Set(incoming).size !== incoming.length) {
          throw new Error("layout contains duplicate panes");
        }
        if (incoming.some((paneId) => !existing.has(paneId))) {
          throw new Error("layout references panes from another tab");
        }
        tab.layout = sanitizeAppliedLayout(layout);
        tab.zoomedPaneId = null;
        tab.focusedPaneId = incoming[0] ?? tab.focusedPaneId;
        if (this.activeTabId === tab.id) {
          this.focusedPaneId = tab.focusedPaneId;
        }
        this.changed();
        return {
          handled: true,
          result: this.stateViewForClient(client),
        };
      }
      case "pane.close":
        this.closePane(requiredAliasString(message.paneId));
        return { handled: true, result: this.stateViewForClient(client) };
      case "pane.read": {
        const paneId = requiredAliasString(message.paneId);
        const pane = this.requirePane(paneId);
        const rows = typeof message.rows === "number" ? message.rows : 30;
        const source = optionalAliasString(message.source);
        return {
          handled: true,
          result: {
            paneId,
            lines: pane.snapshot(
              rows,
              source === "visible" || source === "recent" ||
                source === "recent-unwrapped"
                ? source
                : "recent-unwrapped",
            ),
          },
        };
      }
      case "pane.send_text": {
        const paneId = requiredAliasString(message.paneId);
        const text = requiredAliasString(message.text);
        this.requirePane(paneId).write(text);
        return { handled: true, result: { paneId, accepted: true } };
      }
      case "pane.send_keys": {
        const paneId = requiredAliasString(message.paneId);
        const keys = requiredAliasString(message.keys);
        this.requirePane(paneId).write(keys);
        return { handled: true, result: { paneId, accepted: true } };
      }
      case "clipboard.write":
      {
        const text = requiredAliasString(message.text);
        await writeClipboardText(text);
        return { handled: true, result: { bytes: text.length } };
      }
      case "agent.list": {
        const panes = this.stateViewForClient(client).panes;
        return {
          handled: true,
          result: panes.filter((pane) => pane.agent !== null),
        };
      }
      case "agent.get": {
        const target = requiredAliasString(message.target);
        return { handled: true, result: this.resolveAgentOrPane(client, target) };
      }
      case "agent.read": {
        const target = requiredAliasString(message.target);
        const pane = this.resolveAgentOrPane(client, target);
        const rows = typeof message.rows === "number" ? message.rows : 80;
        return {
          handled: true,
          result: {
            paneId: pane.id,
            lines: this.requirePane(pane.id).snapshot(rows, "recent-unwrapped"),
          },
        };
      }
      default:
        return { handled: false };
    }
  }

  private async dispatch(
    client: ClientState,
    message: { id: string } & ShepherdRequest,
  ): Promise<unknown> {
    switch (message.type) {
      case "hello":
        return {
          product: "shepherd",
          protocolVersion: 1,
          clientId: client.id,
        };
      case "state.get":
        return this.stateViewForClient(client);
      case "task.get":
        return this.requirePane(message.paneId).task;
      case "task.changes":
        return taskChanges(this.requirePane(message.paneId).currentCwd);
      case "task.update": {
        const pane = this.requirePane(message.paneId);
        pane.task = updateTask(pane.task, message.patch, message.source, message.expectedRevision);
        this.persist();
        this.changed();
        return pane.task;
      }
      case "agent.send": {
        const pane = this.requirePane(message.paneId);
        if (pane.exitCode !== null || !pane.agent || !["idle", "done"].includes(pane.status)) {
          throw new Error("Inspect the terminal first: sending a new instruction requires an idle agent.");
        }
        if (typeof message.text !== "string" || !message.text.trim() || message.text.length > 8000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(message.text)) {
          throw new Error("Instruction must be 1 to 8000 characters without terminal control codes");
        }
        pane.task = updateTask(pane.task, { title: message.text.trim().slice(0, 160), review: "none", blocker: "", summary: "", nextAction: "", checkStatus: "unknown", checkSummary: "" });
        pane.paste(message.text);
        pane.write("\r");
        this.persist();
        this.changed();
        return { paneId: pane.id, accepted: true };
      }
      case "agent.manifests":
        return AGENTS.map((definition) => ({
          id: definition.id,
          commands: definition.commands.map((pattern) => pattern.source),
          rules: definition.rules.map((entry) => ({
            id: entry.id,
            state: entry.state,
            priority: entry.priority,
            region: entry.region,
          })),
        }));
      case "marketplace.refresh":
        return this.refreshMarketplace();
      case "worktree.list": {
        const base = message.workspaceId
          ? this.requireWorkspace(message.workspaceId).rootPath
          : message.root ?? process.cwd();
        const worktrees = await listWorktrees(await discoverRepository(base));
        const checkouts = await this.workspaceCheckoutPaths();
        return worktrees.map((worktree) => ({
          ...worktree,
          openWorkspaceId: this.workspaces.find((workspace) =>
            checkouts.get(workspace.id) === canonicalPath(worktree.path)
          )?.id ?? null,
        }));
      }
      case "worktree.create": {
        const base = message.root ??
          this.requireWorkspace(
            message.workspaceId ?? this.selectionForClient(client).workspaceId,
          ).rootPath;
        const status = await gitStatus(base);
        if (!status) throw new Error(`not a Git repository: ${base}`);
        const root = status.repoRoot;
        const directory = expandHome(this.config.worktrees.directory);
        const target = message.path ??
          path.join(directory, status.repoName, branchSlug(message.branch));
        await createWorktree({
          root,
          path: target,
          branch: message.branch,
          createBranch: message.createBranch ?? !(await branchExists(root, message.branch)),
          startPoint: message.base ?? message.startPoint,
        });
        const canonical = canonicalPath(target);
        const worktree = (await listWorktrees(root)).find((entry) =>
          entry.path === canonical
        );
        if (!worktree) throw new Error("Git did not report the new worktree");
        // expanded calls (no explicit path) open the worktree as a
        // workspace; explicit-path calls only create it.
        if (!(message.open ?? message.path === undefined)) return worktree;
        this.createWorkspace("", worktree.path);
        const workspace = this.workspaces[this.workspaces.length - 1];
        if (workspace && message.focus !== false) {
          this.selectWorkspaceForClient(client, workspace);
        }
        void this.refreshGitStatus();
        this.changed();
        return { worktree, workspaceId: workspace?.id ?? null };
      }
      case "worktree.open": {
        const target = canonicalPath(message.path);
        const root = await discoverRepository(target);
        const worktree = (await listWorktrees(root)).find((entry) =>
          entry.path === target
        );
        if (!worktree) {
          throw new Error(`not a worktree in ${root}: ${message.path}`);
        }
        const state = this.createWorkspace(
          message.name ?? "",
          worktree.path,
        );
        return {
          ...state,
          worktree: {
            path: worktree.path,
            branch: worktree.branch,
            commit: worktree.commit,
          },
        };
      }
      case "worktree.remove": {
        if (message.workspaceId) {
          const workspace = this.requireWorkspace(message.workspaceId);
          const status = await gitStatus(workspace.rootPath);
          if (!status?.linked) throw new Error("workspace is not a linked worktree");
          await removeWorktree(status.repoRoot, status.checkoutPath, message.force ?? false);
          this.closeWorkspace(workspace.id);
          return { path: status.checkoutPath, removed: true };
        }
        if (!message.root || !message.path) {
          throw new Error("worktree.remove needs workspaceId or root and path");
        }
        const root = await discoverRepository(message.root);
        const target = canonicalPath(message.path);
        const checkouts = await this.workspaceCheckoutPaths();
        const open = this.workspaces.find((workspace) =>
          checkouts.get(workspace.id) === target
        );
        if (open) {
          throw new Error(`close workspace ${open.name || open.id} before removing its worktree`);
        }
        await removeWorktree(root, target, message.force ?? false);
        return { path: target, removed: true };
      }
      case "tab.create":
        this.createTab(message.name ?? "", client);
        return this.stateViewForClient(client);
      case "tab.select": {
        const tab = this.requireTab(message.tabId);
        const workspace = this.requireWorkspaceByTab(tab.id);
        this.selectTabForClient(client, workspace, tab);
        this.changed();
        return this.stateViewForClient(client);
      }
      case "tab.close":
        this.closeTab(message.tabId);
        return this.stateViewForClient(client);
      case "tab.rename": {
        const tab = this.requireTab(message.tabId);
        tab.name = normalizeName(message.name);
        this.changed();
        return this.stateViewForClient(client);
      }
      case "workspace.create":
        this.createWorkspace(message.name ?? "", this.newPaneCwd(client));
        this.selectWorkspaceForClient(
          client,
          this.workspaces[this.workspaces.length - 1],
        );
        return this.stateViewForClient(client);
      case "workspace.select": {
        this.selectWorkspaceForClient(
          client,
          this.requireWorkspace(message.workspaceId),
        );
        this.changed();
        return this.stateViewForClient(client);
      }
      case "workspace.close":
        this.closeWorkspace(message.workspaceId);
        return this.stateViewForClient(client);
      case "workspace.rename": {
        const workspace = this.requireWorkspace(message.workspaceId);
        workspace.name = message.name.trim() ? normalizeName(message.name) : "";
        this.changed();
        return this.stateViewForClient(client);
      }
      case "pane.create":
        return this.createPane(message, client);
      case "pane.focus": {
        const tab = this.requireTabByPane(message.paneId);
        this.requirePane(message.paneId);
        const workspace = this.requireWorkspaceByTab(tab.id);
        if (client.selection?.focusedPaneId !== message.paneId) {
          this.panes.get(client.selection?.focusedPaneId ?? "")?.focus(false);
          this.panes.get(message.paneId)?.focus(true);
        }
        focusTabPane(tab, message.paneId);
        client.selection = {
          workspaceId: workspace.id,
          tabId: tab.id,
          focusedPaneId: message.paneId,
        };
        this.activeWorkspaceId = workspace.id;
        this.activeTabId = tab.id;
        this.focusedPaneId = message.paneId;
        this.changed();
        return this.stateViewForClient(client);
      }
      case "pane.rename": {
        const pane = this.requirePane(message.paneId);
        pane.title = normalizeName(message.title);
        this.changed();
        return this.stateViewForClient(client);
      }
      case "pane.zoom": {
        const tab = this.requireTabByPane(message.paneId);
        this.requirePane(message.paneId);
        tab.zoomedPaneId = message.zoomed === undefined
          ? (tab.zoomedPaneId === message.paneId ? null : message.paneId)
          : (message.zoomed ? message.paneId : null);
        this.changed();
        return this.stateViewForClient(client);
      }
      case "pane.swap": {
        const paneId = message.paneId ?? this.selectionForClient(client).focusedPaneId;
        const targetPaneId = message.targetPaneId ??
          (message.direction ? this.neighbor(paneId, message.direction) : null);
        this.requirePane(paneId);
        if (!targetPaneId) return this.stateViewForClient(client);
        this.requirePane(targetPaneId);
        for (const tab of this.allTabs()) {
          tab.layout = swapPaneIds(tab.layout, paneId, targetPaneId);
        }
        this.changed();
        return this.stateViewForClient(client);
      }
      case "pane.neighbor": {
        const paneId = message.paneId ?? this.selectionForClient(client).focusedPaneId;
        return { paneId: this.neighbor(paneId, message.direction) };
      }
      case "pane.focus_direction": {
        const paneId = message.paneId ?? this.selectionForClient(client).focusedPaneId;
        const target = this.neighbor(paneId, message.direction);
        if (!target) return this.stateViewForClient(client);
        return await this.dispatch(client, { id: "", type: "pane.focus", paneId: target });
      }
      case "pane.move":
        this.movePane(message.paneId, message.targetTabId);
        return this.stateViewForClient(client);
      case "pane.report_metadata": {
        const pane = this.requirePane(message.paneId);
        const { type: _type, paneId: _paneId, source, ...report } = message;
        pane.metadata.report(source, report);
        this.changed();
        return { accepted: true };
      }
      case "workspace.report_metadata": {
        this.requireWorkspace(message.workspaceId);
        let store = this.workspaceMetadata.get(message.workspaceId);
        if (!store) {
          store = new MetadataStore();
          this.workspaceMetadata.set(message.workspaceId, store);
        }
        store.report(message.source, {
          tokens: message.tokens,
          ttlMs: message.ttlMs,
          seq: message.seq,
        });
        this.changed();
        return { accepted: true };
      }
      case "agent.view.set":
        this.agentView = message.view;
        this.changed();
        return { accepted: true };
      case "agent.view.clear":
        if (!message.source || this.agentView?.source === message.source) {
          this.agentView = null;
          this.changed();
        }
        return { accepted: true };
      case "client.window_title": {
        const listeners = [...this.clients].filter((entry) =>
          entry.subscribed && !entry.socket.destroyed
        );
        const title = message.title === null
          ? null
          : String(message.title).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 256);
        const changed = title !== this.windowTitleOverride;
        this.windowTitleOverride = title;
        void this.emitEvent("client.window_title", { title });
        return {
          changed,
          reason: listeners.length === 0 ? "no_foreground_client" : title === null ? "cleared" : "set",
        };
      }
      case "pane.move_new":
        return this.movePaneToNew(message.paneId, message.destination, message);
      case "pane.resize-layout": {
        const tab = this.requireTabByPane(message.paneId);
        this.requirePane(message.paneId);
        const delta = Math.max(-0.3, Math.min(0.3, message.delta));
        tab.layout = resizePaneRatio(tab.layout, message.paneId, delta);
        this.changed();
        return this.stateViewForClient(client);
      }
      case "pane.input":
        this.requirePane(message.paneId).input(message.data);
        this.followLive(client, message.paneId);
        return { accepted: true };
      case "pane.paste":
        this.requirePane(message.paneId).paste(message.text);
        this.followLive(client, message.paneId);
        return { accepted: true };
      case "surface.scroll": {
        const pane = this.requirePane(message.paneId);
        const subscription = client.surfaces.get(message.paneId);
        if (subscription) {
          subscription.scrollBy(message.lines, pane);
          this.scheduleSurfaceFlush();
        } else {
          pane.scroll(message.lines);
        }
        return { accepted: true };
      }
      case "notification.show": {
        const listeners = [...this.clients].filter((entry) =>
          entry.subscribed && !entry.socket.destroyed
        );
        if (listeners.length === 0) return { reason: "no_foreground_client" };
        void this.emitEvent("notification.show", {
          title: String(message.title).slice(0, 80),
          body: String(message.body ?? "").slice(0, 240),
          position: message.position ?? null,
          sound: message.sound ?? "none",
        });
        return { reason: "shown" };
      }
      case "server.reload_config": {
        const loaded = loadConfig();
        this.config = loaded.config;
        return { status: "reloaded", diagnostics: loaded.diagnostics };
      }
      case "tab.move": {
        const workspace = this.requireWorkspaceByTab(message.tabId);
        const tab = this.requireTab(message.tabId);
        const remaining = workspace.tabs.filter((entry) => entry.id !== tab.id);
        const index = Math.max(0, Math.min(remaining.length, Math.floor(message.insertIndex)));
        remaining.splice(index, 0, tab);
        workspace.tabs = remaining;
        this.changed();
        return this.stateViewForClient(client);
      }
      case "workspace.move": {
        const workspace = this.requireWorkspace(message.workspaceId);
        const remaining = this.workspaces.filter((entry) => entry.id !== workspace.id);
        const index = Math.max(0, Math.min(remaining.length, Math.floor(message.insertIndex)));
        remaining.splice(index, 0, workspace);
        this.workspaces = remaining;
        this.changed();
        return this.stateViewForClient(client);
      }
      case "surface.scroll_to": {
        const pane = this.requirePane(message.paneId);
        client.surfaces.get(message.paneId)?.scrollTo(message.top, pane);
        this.scheduleSurfaceFlush();
        return { accepted: true };
      }
      case "pane.text": {
        const pane = this.requirePane(message.paneId);
        return {
          ...pane.text(message.start, Math.min(message.count, 100_000)),
          revision: pane.revision,
        };
      }
      case "pane.search":
        return {
          match: this.requirePane(message.paneId).search(
            message.query,
            { line: message.line, col: message.col },
            message.direction,
          ),
        };
      case "command.run":
        return this.runCustomCommand(client, message.command, message.commandType);
      case "popup.close": {
        const paneId = message.paneId ??
          [...this.popups.entries()].find(([, owner]) => owner === client.id)?.[0];
        if (!paneId || !this.popups.has(paneId)) throw new Error("popup_not_open");
        this.closePopup(paneId);
        return { closed: paneId };
      }
      case "pane.edit_scrollback": {
        const pane = this.requirePane(message.paneId);
        const buffer = pane.text(0, Number.MAX_SAFE_INTEGER);
        const lines: string[] = [];
        buffer.lines.forEach((line, index) => {
          if (buffer.wrapped[index] && lines.length > 0) {
            lines[lines.length - 1] += line;
          } else {
            lines.push(line);
          }
        });
        for (let index = 0; index < lines.length; index += 1) {
          lines[index] = (lines[index] ?? "").replace(/\s+$/, "");
        }
        while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        const file = path.join(
          os.tmpdir(),
          `shepherd-scrollback-${pane.id}-${Date.now()}.txt`,
        );
        fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
        const editor = process.env.VISUAL || process.env.EDITOR || "vi";
        return this.openPopup(
          client,
          `${editor} ${shellQuote(file)}; rm -f ${shellQuote(file)}`,
          pane.currentCwd,
        );
      }
      case "agent.explain": {
        const view = this.resolveAgentOrPane(client, message.target);
        const pane = this.requirePane(view.id);
        if (!pane.agent) {
          return { agent: null, state: "unknown", fallback_reason: "unknown_agent" };
        }
        const detection = evaluate(manifestFor(pane.agent), pane.detectionInput());
        return { ...explain(pane.agent, detection), status: pane.status, signal: pane.detector.signal() };
      }
      case "pane.clear":
        this.requirePane(message.paneId).clear();
        return { accepted: true };
      case "pane.focus-report":
        this.requirePane(message.paneId).focus(message.focused);
        client.hostFocused = message.focused;
        if (message.focused) this.markVisibleSeen(client);
        return { accepted: true };
      case "pane.mouse": {
        const { type: _type, paneId, ...event } = message;
        this.followLive(client, paneId);
        return { accepted: this.requirePane(paneId).mouse(event) };
      }
      case "surface.subscribe":
        this.subscribeSurfaces(client, message.panes);
        return { accepted: true };
      case "pane.resize": {
        const paneId = message.paneId ?? this.selectionForClient(client).focusedPaneId;
        if (message.direction) {
          const tab = this.requireTabByPane(paneId);
          const amount = Math.max(0, Math.min(0.5, message.amount ?? 0.05));
          tab.layout = resizeInDirection(
            tab.layout,
            LAYOUT_AREA,
            paneId,
            message.direction,
            amount,
          );
          this.changed();
          return this.stateViewForClient(client);
        }
        this.requirePane(paneId).resize(message.cols ?? 80, message.rows ?? 24);
        return { accepted: true };
      }
      case "pane.scroll":
        this.requirePane(message.paneId).scroll(message.lines);
        return { accepted: true };
      case "pane.close":
        this.closePane(message.paneId);
        return this.stateViewForClient(client);
      case "pane.snapshot": {
        const pane = this.requirePane(message.paneId);
        return {
          paneId: pane.id,
          lines: pane.snapshot(message.rows, message.source),
        };
      }
      case "pane.wait":
        return this.waitForPaneStatus(
          message.paneId,
          message.statuses,
          message.timeoutMs,
        );
      case "pane.report_agent": {
        const pane = this.requirePane(message.paneId);
        validateHookReport(message.state, message.source, message.ttlMs);
        if (typeof message.agent !== "string" || !/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(message.agent)) throw new Error("invalid agent identifier");
        // A hook names its agent and becomes the authority for its state.
        pane.detector.setAgent(message.agent, Date.now());
        pane.detector.reportHook(
          message.state,
          message.source,
          Date.now(),
          this.completionSuppressed(pane.id),
          message.ttlMs,
        );
        this.publishAgentStatuses();
        return { accepted: true };
      }
      case "integration.list":
        return listIntegrations();
      case "integration.install":
        return { messages: installIntegration(message.target) };
      case "integration.uninstall":
        return { messages: uninstallIntegration(message.target) };
      case "pane.report_agent_session": {
        const pane = this.requirePane(message.paneId);
        pane.detector.setAgent(message.agent, Date.now());
        pane.agentSession = {
          source: message.source,
          agent: message.agent,
          value: message.sessionId,
        };
        this.changed();
        return { accepted: true };
      }
      case "pane.link_at":
        return { url: this.requirePane(message.paneId).linkAt(message.line, message.col) };
      case "pane.release_agent": {
        // Drop the hook's authority and the agent it reported; the process
        // probe finds the agent again if it is still running.
        const pane = this.requirePane(message.paneId);
        pane.agentSession = null;
        const detector = pane.detector;
        detector.releaseHook();
        detector.setAgent(null, Date.now());
        this.publishAgentStatuses();
        this.changed();
        return { accepted: true };
      }
      case "server.live_handoff":
        return await this.liveHandoff();
      case "server.stop":
        setTimeout(() => {
          void this.stop().finally(() => process.exit(0));
        }, 50);
        return { stopping: true };
      case "plugin.link":
        return this.linkPlugin(message.path);
      case "plugin.unlink":
        return this.unlinkPlugin(message.pluginId);
      case "plugin.set-enabled":
        return this.setPluginEnabled(message.pluginId, message.enabled);
      case "plugin.action-invoke":
        return this.invokePlugin(
          message.pluginId,
          message.actionId,
          client,
          message.context,
        );
      case "plugin.uninstall":
        return this.uninstallPlugin(message.pluginId);
      case "plugin.config-dir": {
        const plugin = this.requirePlugin(message.pluginId);
        const runtime = this.pluginRuntime(plugin.manifest.id);
        ensurePluginDirectories(runtime);
        return { pluginId: plugin.manifest.id, path: runtime.configDirectory };
      }
      case "plugin.log-list": {
        if (message.pluginId !== undefined) this.requirePlugin(message.pluginId);
        return { logs: this.pluginLogs.list(message.pluginId, message.limit) };
      }
      case "plugin.pane-open":
        return await this.openPluginPane(client, message);
      case "plugin.pane-focus":
        return await this.focusPluginPane(client, message.paneId);
      case "plugin.pane-close":
        return this.closePluginPane(message.paneId);
      case "plugin.link-open":
        return this.openLinkWithPlugin(client, message.url);
      case "machine.refresh": {
        this.syncSavedMachines();
        const link = this.machines.link(loadMachines(), message.labelOrId);
        try {
          await link.refresh();
        } catch {
          // The view carries the error and status.
        }
        return link.view();
      }
      case "machine.sync":
        this.syncSavedMachines();
        return this.machines.views();
      case "machine.request": {
        const link = this.machines.link(loadMachines(), message.labelOrId);
        const request = message.request;
        if (typeof request?.type !== "string") {
          throw new Error("machine.request needs a request with a type");
        }
        return link.request(request, message.timeoutMs ?? 20_000);
      }
      case "machine.agent-get": {
        const link = this.machines.link(loadMachines(), message.labelOrId);
        return operationResult(
          link,
          message.target,
          "get",
          await remoteAgentGet(link, message.target),
        );
      }
      case "machine.pane-read": {
        const link = this.machines.link(loadMachines(), message.labelOrId);
        return operationResult(
          link,
          message.paneId,
          "read",
          await remotePaneRead(
            link,
            message.paneId,
            message.rows ?? 80,
            message.source ?? "recent-unwrapped",
          ),
        );
      }
      case "machine.pane-input": {
        const link = this.machines.link(loadMachines(), message.labelOrId);
        const result = await link.request({
          type: "pane.input",
          paneId: message.paneId,
          data: message.raw ? message.data : `${message.data}\r`,
        });
        return operationResult(link, message.paneId, "read", JSON.stringify(result));
      }
      case "machine.agent-read": {
        const link = this.machines.link(loadMachines(), message.labelOrId);
        return operationResult(
          link,
          message.target,
          "read",
          await remoteAgentRead(
            link,
            message.target,
            message.rows ?? 80,
            message.source ?? "recent-unwrapped",
          ),
        );
      }
      case "machine.agent-prompt": {
        const link = this.machines.link(loadMachines(), message.labelOrId);
        const result = await remoteAgentPrompt(
          link,
          message.target,
          message.prompt,
          message.timeoutMs ?? 120_000,
        );
        return operationResult(
          link,
          message.target,
          "prompt",
          result.value,
          result.timedOut ? 1 : 0,
        );
      }
      case "config.keymap": {
        const keys = this.config.keys;
        return {
          prefix: keys.prefix,
          bindings: keys.bindings,
          navigate: keys.navigate,
          commands: keys.commands,
        };
      }
      case "events.subscribe":
        client.subscribed = true;
        this.updateMachineDemand();
        return { subscribed: true };
      case "events.unsubscribe":
        client.subscribed = false;
        this.updateMachineDemand();
        return { subscribed: false };
      case "events.wait":
        return this.waitForEvent(message.event, message.timeoutMs);
      default: {
        const unsupported = message as ShepherdRequest;
        throw new Error(`unsupported request: ${unsupported.type}`);
      }
    }
  }

  private createTab(name: string, client: ClientState): StateView {
    const workspace = this.activeWorkspaceForClient(client);
    const cwd = this.newPaneCwd(client);
    const id = `t${this.nextTab}`;
    this.nextTab += 1;
    const pane = this.spawnPane({
      title: "",
      command: null,
      cwd,
      location: { workspaceId: workspace.id, tabId: id },
    });

    workspace.tabs.push({
      id,
      name,
      layout: paneLayout(pane.id),
      focusedPaneId: pane.id,
      zoomedPaneId: null,
    });
    workspace.activeTabId = id;
    client.selection = {
      workspaceId: workspace.id,
      tabId: id,
      focusedPaneId: pane.id,
    };
    this.activeTabId = id;
    this.focusedPaneId = pane.id;
    this.changed();
    return this.stateViewForClient(client);
  }

  private createPane(message: {
    direction?: SplitDirection;
    command?: string;
    cwd?: string;
    title?: string;
    focus?: boolean;
  }, client: ClientState): StateView {
    const tab = this.activeTabForClient(client);
    const targetPaneId = tab.focusedPaneId;
    const pane = this.spawnPane({
      title: message.title ??
        (message.command ? commandLabel(message.command) : ""),
      command: message.command ?? null,
      cwd: message.cwd ?? this.newPaneCwd(client),
      location: {
        workspaceId: this.requireWorkspaceByTab(tab.id).id,
        tabId: tab.id,
      },
    });

    tab.layout = splitPane(
      tab.layout,
      targetPaneId,
      pane.id,
      message.direction ?? "right",
    );
    tab.zoomedPaneId = null;
    if (message.focus !== false) {
      focusTabPane(tab, pane.id);
      const workspace = this.requireWorkspaceByTab(tab.id);
      client.selection = {
        workspaceId: workspace.id,
        tabId: tab.id,
        focusedPaneId: pane.id,
      };
      this.focusedPaneId = pane.id;
    }
    this.changed();
    return this.stateViewForClient(client);
  }

  private closePane(paneId: string): StateView {
    const closing = this.requirePane(paneId);
    closing.close();
    this.panes.delete(paneId);
    const pluginPane = this.finishPluginPane(paneId, closing.exitCode);

    for (const workspace of this.workspaces) {
      for (const tab of workspace.tabs) {
        const nextLayout = removePane(tab.layout, paneId);
        if (nextLayout) {
          tab.layout = nextLayout;
          const remaining = paneIds(tab.layout);
          tab.focusHistory = (tab.focusHistory ?? []).filter(
            (entry) => entry !== paneId && remaining.includes(entry),
          );
          if (!remaining.includes(tab.focusedPaneId)) {
            tab.focusedPaneId = tab.focusHistory[0] ?? remaining[0] ?? "";
          }
          if (tab.zoomedPaneId === paneId) tab.zoomedPaneId = null;
        }
      }
      workspace.tabs = workspace.tabs.filter(
        (tab) => paneIds(tab.layout).some((id) => this.panes.has(id)),
      );
    }
    if (pluginPane?.restore) this.restoreAfterOverlay(pluginPane.restore);

    this.removeEmptyWorkspaces();
    this.normalizeSelection();
    this.changed();
    return this.stateView();
  }

  /** Puts back the focus and zoom a tab had before an overlay opened. */
  private restoreAfterOverlay(restore: NonNullable<PluginPaneRecord["restore"]>): void {
    const tab = this.allTabs().find((entry) => entry.id === restore.tabId);
    if (!tab) return;
    const remaining = paneIds(tab.layout);
    if (remaining.includes(restore.focusedPaneId)) {
      tab.focusedPaneId = restore.focusedPaneId;
      if (this.activeTabId === tab.id) this.focusedPaneId = restore.focusedPaneId;
      for (const client of this.clients) {
        if (client.selection?.tabId === tab.id) {
          client.selection.focusedPaneId = restore.focusedPaneId;
        }
      }
    }
    tab.zoomedPaneId = restore.zoomedPaneId && remaining.includes(restore.zoomedPaneId)
      ? restore.zoomedPaneId
      : null;
  }

  private movePane(paneId: string, targetTabId: string): StateView {
    const pane = this.requirePane(paneId);
    const sourceTab = this.requireTabByPane(paneId);
    const targetTab = this.requireTab(targetTabId);
    if (sourceTab.id === targetTab.id) {
      throw new Error("pane is already in that tab");
    }
    this.detachPane(paneId);

    targetTab.layout = splitPane(
      targetTab.layout,
      targetTab.focusedPaneId,
      pane.id,
      "right",
    );
    targetTab.focusedPaneId = pane.id;
    targetTab.zoomedPaneId = null;

    const targetWorkspace = this.requireWorkspaceByTab(targetTab.id);
    this.selectWorkspace(targetWorkspace);
    targetWorkspace.activeTabId = targetTab.id;
    this.activeTabId = targetTab.id;
    this.focusedPaneId = pane.id;
    this.changed();
    return this.stateView();
  }

  /** Moves a pane into a new tab (of its workspace or another) or into a
   * new workspace. Returns the ids created. */
  private movePaneToNew(
    paneId: string,
    destination: "tab" | "workspace",
    options: { workspaceId?: string; label?: string; tabLabel?: string },
  ): { tabId: string; workspaceId: string } {
    const pane = this.requirePane(paneId);
    const sourceWorkspace = this.requireWorkspaceByTab(this.requireTabByPane(paneId).id);
    const targetWorkspace = destination === "tab"
      ? (options.workspaceId ? this.requireWorkspace(options.workspaceId) : sourceWorkspace)
      : null;
    this.detachPane(paneId);
    const tab: RunningTab = {
      id: `t${this.nextTab}`,
      name: destination === "tab" ? options.label ?? "" : options.tabLabel ?? "",
      layout: paneLayout(pane.id),
      focusedPaneId: pane.id,
      zoomedPaneId: null,
    };
    this.nextTab += 1;
    let workspace: RunningWorkspace;
    if (targetWorkspace && this.workspaces.includes(targetWorkspace)) {
      workspace = targetWorkspace;
      workspace.tabs.push(tab);
    } else {
      workspace = {
        id: `w${this.nextWorkspace}`,
        name: destination === "workspace" ? options.label ?? "" : "",
        rootPath: pane.currentCwd,
        tabs: [tab],
        activeTabId: tab.id,
      };
      this.nextWorkspace += 1;
      this.workspaces.push(workspace);
    }
    workspace.activeTabId = tab.id;
    this.normalizeSelection();
    this.normalizeClientSelections();
    void this.refreshGitStatus();
    this.changed();
    return { tabId: tab.id, workspaceId: workspace.id };
  }

  /** Removes a pane from its tab's layout without closing it; an emptied
   * tab or workspace is dropped. */
  private detachPane(paneId: string): void {
    const sourceTab = this.requireTabByPane(paneId);
    const nextLayout = removePane(sourceTab.layout, paneId);
    if (nextLayout) {
      sourceTab.layout = nextLayout;
      const remaining = paneIds(sourceTab.layout);
      sourceTab.focusedPaneId = remaining[0] ?? "";
      if (sourceTab.zoomedPaneId && !remaining.includes(sourceTab.zoomedPaneId)) {
        sourceTab.zoomedPaneId = null;
      }
    } else {
      const sourceWorkspace = this.requireWorkspaceByTab(sourceTab.id);
      sourceWorkspace.tabs = sourceWorkspace.tabs.filter(
        (tab) => tab.id !== sourceTab.id,
      );
      if (sourceWorkspace.tabs.length > 0) {
        sourceWorkspace.activeTabId =
          sourceWorkspace.tabs.find((tab) => tab.id === sourceWorkspace.activeTabId)?.id ??
          sourceWorkspace.tabs[0]?.id ??
          "";
      }
      this.workspaces = this.workspaces.filter(
        (workspace) => workspace.tabs.length > 0,
      );
    }
  }

  private closeTab(tabId: string): StateView {
    const workspace = this.requireWorkspaceByTab(tabId);
    const tab = this.requireTab(tabId);
    for (const paneId of paneIds(tab.layout)) {
      const pane = this.panes.get(paneId);
      pane?.close();
      this.panes.delete(paneId);
    }
    workspace.tabs = workspace.tabs.filter((entry) => entry.id !== tabId);
    this.removeEmptyWorkspaces();
    this.normalizeSelection();
    this.changed();
    return this.stateView();
  }

  private createWorkspace(name: string, rootPath = process.cwd()): StateView {
    const id = `w${this.nextWorkspace}`;
    this.nextWorkspace += 1;
    const pane = this.spawnPane({
      title: "",
      command: null,
      cwd: rootPath,
      location: { workspaceId: id, tabId: `t${this.nextTab}` },
    });
    const tab: RunningTab = {
      id: `t${this.nextTab}`,
      name: "",
      layout: paneLayout(pane.id),
      focusedPaneId: pane.id,
      zoomedPaneId: null,
    };
    this.nextTab += 1;
    this.workspaces.push({
      id,
      name,
      rootPath,
      tabs: [tab],
      activeTabId: tab.id,
    });
    this.selectWorkspace(this.workspaces[this.workspaces.length - 1]);
    this.changed();
    void this.refreshGitStatus();
    return this.stateView();
  }

  private closeWorkspace(workspaceId: string): StateView {
    const workspace = this.requireWorkspace(workspaceId);
    for (const tab of workspace.tabs) {
      for (const paneId of paneIds(tab.layout)) {
        const pane = this.panes.get(paneId);
        pane?.close();
        this.panes.delete(paneId);
      }
    }
    this.workspaces = this.workspaces.filter((entry) => entry.id !== workspaceId);
    if (this.workspaces.length === 0) this.createWorkspace("");
    this.normalizeSelection();
    this.changed();
    return this.stateView();
  }

  private selectWorkspace(workspace: RunningWorkspace): void {
    const activeTab = workspace.tabs.find((tab) => tab.id === workspace.activeTabId)
      ?? workspace.tabs[0];
    this.activeWorkspaceId = workspace.id;
    workspace.activeTabId = activeTab?.id ?? "";
    this.activeTabId = activeTab?.id ?? "";
    this.focusedPaneId = activeTab?.focusedPaneId ?? "";
  }

  private removeEmptyWorkspaces(): void {
    this.workspaces = this.workspaces.filter(
      (workspace) => workspace.tabs.length > 0,
    );
    if (this.workspaces.length === 0) this.createWorkspace("");
  }

  private normalizeSelection(): void {
    if (!this.workspaces.some((workspace) => workspace.id === this.activeWorkspaceId)) {
      this.activeWorkspaceId = this.workspaces[0]?.id ?? "";
    }
    const workspace = this.activeWorkspace();
    if (!workspace.tabs.some((tab) => tab.id === workspace.activeTabId)) {
      workspace.activeTabId = workspace.tabs[0]?.id ?? "";
    }
    const tab = workspace.tabs.find((entry) => entry.id === workspace.activeTabId);
    this.activeTabId = tab?.id ?? "";
    this.focusedPaneId = tab?.focusedPaneId ?? "";
    this.normalizeClientSelections();
  }

  private spawnPane(options: {
    title: string;
    command: string | null;
    cwd: string;
    notice?: string;
    env?: Record<string, string>;
    /** Saved screen history written to the emulator before the shell runs. */
    replay?: string;
    /** Workspace and tab the pane starts in, exported to its environment. */
    location?: { workspaceId: string; tabId: string };
  }): PaneTerminal {
    const id = `p${this.nextPane}`;
    this.nextPane += 1;
    const { env: extraEnv, location, ...paneOptions } = options;
    const pane = new PaneTerminal({
      id,
      ...paneOptions,
      shell: configuredShell(
        this.config.terminal.default_shell,
        this.config.terminal.shell_mode,
      ),
      scrollbackLines: Math.max(
        1_000,
        Math.min(50_000, Math.round(this.config.advanced.scrollback_limit_bytes / 1_000)),
      ),
      env: {
        ...extraEnv,
        SHEPHERD_SOCKET_PATH: this.socketPath,
        SHEPHERD_BIN_PATH: process.argv[1] ?? "",
        ...(location
          ? { SHEPHERD_WORKSPACE_ID: location.workspaceId, SHEPHERD_TAB_ID: location.tabId }
          : {}),
      },
      onExit: () => setImmediate(() => this.handlePaneExit(id)),
      onBell: () => void this.emitEvent("pane.bell", { paneId: id }),
      onChange: () => this.scheduleSurfaceFlush(),
      onCwdChange: () => { if (!this.stopping) this.changed(); },
      onClipboard: (text) => this.forwardClipboard(id, text),
    });
    this.panes.set(id, pane);
    return pane;
  }

  /** Runs a `[[keys.command]]`: `shell` detached in the background, `pane`
   * in a new split that closes when the command exits. */
  private runCustomCommand(
    client: ClientState,
    command: string,
    type: "shell" | "pane" | "popup",
  ): unknown {
    const selection = this.selectionForClient(client);
    const focused = this.panes.get(selection.focusedPaneId);
    const env = {
      ...process.env,
      SHEPHERD_SOCKET_PATH: this.socketPath,
      SHEPHERD_BIN_PATH: process.argv[1] ?? "",
      SHEPHERD_ACTIVE_WORKSPACE_ID: selection.workspaceId,
      SHEPHERD_ACTIVE_TAB_ID: selection.tabId,
      SHEPHERD_ACTIVE_PANE_ID: selection.focusedPaneId,
      SHEPHERD_ACTIVE_PANE_CWD: focused?.currentCwd ?? "",
    };
    if (type === "pane") {
      return this.createPane({ command, direction: "right" }, client);
    }
    if (type === "popup") {
      return this.openPopup(client, command, focused?.currentCwd ?? process.cwd());
    }
    const child = spawn("/bin/sh", ["-lc", command], {
      cwd: focused?.currentCwd ?? process.cwd(),
      env,
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
    return { started: true, pid: child.pid ?? null };
  }

  /** Replaces the set of panes a client is displaying. Each pane is sized to
   * the client's layout and receives a full frame, then row deltas. */
  private subscribeSurfaces(
    client: ClientState,
    interests: Array<{ paneId: string; cols: number; rows: number }>,
  ): void {
    const next = new Map<string, SurfaceSubscription>();
    for (const interest of interests) {
      const pane = this.panes.get(interest.paneId);
      if (!pane) continue;
      const cols = Math.max(2, Math.floor(interest.cols));
      const rows = Math.max(1, Math.floor(interest.rows));
      pane.resize(cols, rows);
      const existing = client.surfaces.get(interest.paneId);
      const subscription = existing ??
        new SurfaceSubscription(interest.paneId, cols, rows);
      if (existing && (existing.cols !== cols || existing.rows !== rows)) {
        existing.reset(cols, rows);
      }
      next.set(interest.paneId, subscription);
    }
    client.surfaces = next;
    this.scheduleSurfaceFlush();
    this.markVisibleSeen(client);
  }

  private neighbor(
    paneId: string,
    direction: "left" | "right" | "up" | "down",
  ): string | null {
    const tab = this.requireTabByPane(paneId);
    const layout = tab.zoomedPaneId
      ? paneLayout(tab.zoomedPaneId)
      : tab.layout;
    return paneInDirection(layoutGeometry(layout, LAYOUT_AREA), paneId, direction);
  }

  /** Identifies agents from each pane's foreground process, so an agent
   * started from a shell prompt is recognised (and forgotten when it
   * exits). */
  private async detectForegroundAgents(): Promise<void> {
    if (this.detectingAgents || this.panes.size === 0) return;
    this.detectingAgents = true;
    try {
      const table = await processTable();
      if (table.length === 0) return;
      let changed = false;
      for (const [id, pane] of this.panes) {
        if (pane.exitCode !== null) continue;
        const shellPid = pane.processId;
        if (!shellPid) continue;
        const foreground = foregroundProcess(table, shellPid);
        const own = table.find((entry) => entry.pid === shellPid);
        // A pane started with a command execs it in place of the shell.
        const entry = foreground ?? (pane.command ? own : null) ?? null;
        const command = entry ? unwrapCommand(entry.args) : null;
        const agent = command
          ? detectAgentFromCommand(command) ?? detectAgentFromCommand(entry?.args ?? "")
          : null;
        const before = pane.agent;
        const shellInForeground = !foreground && !pane.command;
        if (
          pane.probeAgent(
            agent,
            command,
            shellInForeground,
            Date.now(),
            this.completionSuppressed(id),
          )
        ) {
          changed = true;
          if (pane.agent !== before) {
            void this.emitEvent("pane.agent_detected", { paneId: id, agent: pane.agent });
          }
        }
      }
      if (changed) {
        this.publishAgentStatuses();
        this.changed();
      }
    } finally {
      this.detectingAgents = false;
    }
  }

  /** Hands every running pane to a freshly started daemon (Shepherd's live
   * handoff): PTY master fds are inherited by the new process, which
   * replays each pane's screen and takes over the socket. Processes keep
   * running throughout; clients reconnect. */
  private async liveHandoff(): Promise<unknown> {
    if (process.platform === "win32") throw new Error("platform_unsupported");
    if (this.handingOff) throw new Error("handoff already in progress");
    for (const paneId of [...this.popups.keys()]) this.closePopup(paneId);
    const panes: Array<{
      id: string;
      fd: number;
      pid: number;
      cols: number;
      rows: number;
      title: string;
      command: string | null;
      cwd: string;
      replay: string;
    }> = [];
    for (const pane of this.panes.values()) {
      const state = pane.handoffState();
      if (!state) throw new Error(`pane ${pane.id} cannot be handed off`);
      panes.push({
        id: pane.id,
        fd: state.fd,
        pid: state.pid,
        cols: state.cols,
        rows: state.rows,
        title: pane.title,
        command: pane.command,
        cwd: pane.currentCwd,
        replay: state.replay,
      });
    }
    const file = path.join(stateDirectory(this.session), "handoff.json");
    const payload: HandoffPayload = {
      version: 1,
      state: this.persistedSnapshot(),
      panes: panes.map(({ fd: _fd, ...pane }, index) => ({ ...pane, fdIndex: 3 + index })),
    };
    fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });

    // Stop taking new clients and free the socket path for the new daemon.
    // The listener stays open so connected clients (including the one that
    // asked for the handoff) keep their connections until we exit.
    this.persist();
    this.handingOff = true;
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // Already removed.
    }
    const entry = process.argv[1] ?? "";
    const child = spawn(process.execPath, [
      ...process.execArgv,
      entry,
      "--session",
      this.session,
      "--socket",
      this.socketPath,
      "server",
      "start",
      "--foreground",
    ], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", ...panes.map((pane) => pane.fd)],
      env: { ...process.env, SHEPHERD_HANDOFF_FILE: file },
    });
    child.unref();
    const ready = await waitForSocket(this.socketPath, 30_000);
    if (!ready) {
      // Roll back: keep serving from this daemon.
      try {
        child.kill("SIGKILL");
      } catch {
        // Nothing to stop.
      }
      fs.rmSync(file, { force: true });
      this.handingOff = false;
      await new Promise<void>((resolve) => this.server ? this.server.close(() => resolve()) : resolve());
      await this.listen();
      throw new Error("new daemon did not become ready; handoff cancelled");
    }
    // The new daemon owns the panes now: leave without closing them.
    setTimeout(() => {
      for (const client of this.clients) client.socket.destroy();
      process.exit(0);
    }, 100);
    return { handed_off: true, pid: child.pid ?? null, panes: panes.length };
  }

  /** Rebuilds workspaces and adopts the PTYs described by a handoff file.
   * Returns false when there is nothing usable, so a normal restore runs. */
  private restoreFromHandoff(file: string): boolean {
    let payload: HandoffPayload;
    try {
      payload = JSON.parse(fs.readFileSync(file, "utf8")) as HandoffPayload;
    } catch {
      return false;
    } finally {
      fs.rmSync(file, { force: true });
    }
    if (payload.version !== 1) return false;
    for (const saved of payload.panes) {
      const pane = new PaneTerminal({
        id: saved.id,
        title: saved.title,
        command: saved.command,
        cwd: saved.cwd,
        initialCols: saved.cols,
        initialRows: saved.rows,
        adopt: { fd: saved.fdIndex, pid: saved.pid },
        replay: saved.replay,
        env: { SHEPHERD_SOCKET_PATH: this.socketPath },
        onExit: () => setImmediate(() => this.handlePaneExit(saved.id)),
        onBell: () => void this.emitEvent("pane.bell", { paneId: saved.id }),
        onChange: () => this.scheduleSurfaceFlush(),
        onCwdChange: () => { if (!this.stopping) this.changed(); },
        onClipboard: (text) => this.forwardClipboard(saved.id, text),
      });
      this.panes.set(saved.id, pane);
      pane.task = payload.state.panes.find(entry => entry.id === saved.id)?.task ?? null;
      pane.continuity = "handoff";
    }
    this.workspaces = payload.state.workspaces.map((workspace) => ({
      ...workspace,
      tabs: workspace.tabs.map((tab) => ({
        ...tab,
        zoomedPaneId: tab.zoomedPaneId ?? null,
      })),
    }));
    this.normalizeIdCounters();
    const active = this.workspaces.find((workspace) =>
      workspace.id === payload.state.activeWorkspaceId
    ) ?? this.workspaces[0];
    if (active) this.selectWorkspace(active);
    return this.panes.size > 0;
  }

  /** Drops expired metadata reports and republishes state if any went. */
  private pruneMetadata(): void {
    let changed = false;
    for (const pane of this.panes.values()) {
      if (pane.metadata.prune()) changed = true;
    }
    for (const store of this.workspaceMetadata.values()) {
      if (store.prune()) changed = true;
    }
    if (changed) this.changed();
  }

  /** A space may now be in a checkout subdirectory; compare checkout roots. */
  private async workspaceCheckoutPaths(): Promise<Map<string, string>> {
    return new Map(await Promise.all(this.workspaces.map(async (workspace) => {
      const cwd = workspace.rootPath;
      const checkout = await discoverRepository(cwd).catch(() => cwd);
      return [workspace.id, canonicalPath(checkout)] as const;
    })));
  }

  /** The first tab's root pane supplies the space's directory, as in Herdr. */
  private syncWorkspaceDirectories(): boolean {
    let changed = false;
    for (const workspace of this.workspaces) {
      for (const tab of workspace.tabs) {
        const ids = paneIds(tab.layout);
        if (!tab.rootPaneId || !ids.includes(tab.rootPaneId)) tab.rootPaneId = ids[0];
      }
      const rootPaneId = workspace.tabs[0]?.rootPaneId;
      const cwd = rootPaneId ? this.panes.get(rootPaneId)?.currentCwd : undefined;
      if (!cwd || cwd === workspace.rootPath) continue;
      workspace.rootPath = cwd;
      this.gitStatuses.delete(workspace.id);
      changed = true;
    }
    return changed;
  }

  /** Refresh outside state/render paths, discarding results for old directories. */
  private async refreshGitStatus(): Promise<void> {
    if (this.refreshingGit) {
      this.gitRefreshPending = true;
      return;
    }
    this.refreshingGit = true;
    try {
      do {
        this.gitRefreshPending = false;
        let changed = this.syncWorkspaceDirectories();
        for (const workspace of [...this.workspaces]) {
          const cwd = workspace.rootPath;
          const status = await gitStatus(cwd).catch(() => null);
          if (this.stopping) return;
          if (!this.workspaces.includes(workspace) || workspace.rootPath !== cwd) continue;
          const previous = this.gitStatuses.get(workspace.id);
          this.gitStatuses.set(workspace.id, status);
          if (JSON.stringify(previous ?? null) !== JSON.stringify(status)) changed = true;
        }
        if (changed) this.changed();
      } while (this.gitRefreshPending && !this.stopping);
    } finally {
      this.refreshingGit = false;
    }
  }

  private workspaceLabel(workspace: RunningWorkspace): string {
    if (workspace.name) return workspace.name;
    const git = this.gitStatuses.get(workspace.id);
    if (git?.checkoutPath) return path.basename(git.checkoutPath) || git.checkoutPath;
    const home = os.homedir();
    if (path.resolve(workspace.rootPath) === home) return "~";
    return path.basename(workspace.rootPath) || workspace.rootPath;
  }

  private followLive(client: ClientState, paneId: string): void {
    if (client.surfaces.get(paneId)?.followLive()) this.scheduleSurfaceFlush();
  }

  /** OSC 52 from an app goes to the clients showing that pane, which write
   * it to the clipboard of the machine the user is sitting at. */
  private forwardClipboard(paneId: string, text: string): void {
    const frame = encodeMessage({
      event: "pane.clipboard",
      data: { paneId, text },
      emittedAt: new Date().toISOString(),
    });
    for (const client of this.clients) {
      if (client.socket.destroyed || !client.surfaces.has(paneId)) continue;
      client.socket.write(frame);
    }
  }

  /** Coalesces screen changes into at most ~60 pushes per second. */
  private scheduleSurfaceFlush(): void {
    if (this.surfaceTimer || this.stopping) return;
    const wait = Math.max(0, 16 - (Date.now() - this.lastSurfaceFlush));
    this.surfaceTimer = setTimeout(() => {
      this.surfaceTimer = null;
      this.lastSurfaceFlush = Date.now();
      this.flushSurfaces();
    }, wait);
  }

  private flushSurfaces(): void {
    for (const client of this.clients) {
      if (client.socket.destroyed || client.surfaces.size === 0) continue;
      let batch = "";
      for (const subscription of client.surfaces.values()) {
        const pane = this.panes.get(subscription.paneId);
        if (!pane) continue;
        const frame = subscription.frame(pane);
        if (!frame) continue;
        batch += encodeMessage({
          event: "pane.surface",
          data: frame as unknown as Record<string, unknown>,
          emittedAt: new Date().toISOString(),
        });
      }
      if (batch) client.socket.write(batch);
    }
  }

  /** Exited command-backed tasks stay available for review. Other panes are
   * removed; the last pane closes its tab and the last tab its workspace. */
  private handlePaneExit(paneId: string): void {
    if (this.stopping || !this.panes.has(paneId)) return;
    void this.emitEvent("pane.exited", { paneId, exitCode: this.requirePane(paneId).exitCode });
    if (this.popups.has(paneId)) {
      this.closePopup(paneId);
      return;
    }
    const pane = this.requirePane(paneId);
    // Preserve output for an explicit command/agent run, but never leave the
    // user's interactive shell pane behind after they type `exit`.
    if (pane.command !== null && (pane.agent || pane.task)) {
      pane.detector.exited(Date.now(), false);
      pane.task = updateTask(pane.task, { review: "requested",
        ...(pane.exitCode ? { blocker: `Process exited with code ${pane.exitCode}; inspect its output` } : {}),
      }, "process exit");
      this.agentCompletions.set(paneId, pane.detector.completionSequence);
      this.finishPluginPane(paneId, pane.exitCode);
      this.publishAgentStatuses();
      this.persist();
      this.changed();
      return;
    }
    this.closePane(paneId);
  }

  /** A popup is a pane outside every layout, shown session-modal by the
   * client that opened it and closed when its command exits. */
  private openPopup(
    client: ClientState,
    command: string,
    cwd: string,
    options: { env?: Record<string, string>; details?: Record<string, unknown> } = {},
  ): { paneId: string } {
    const pane = this.spawnPane({ title: "", command, cwd, env: options.env });
    this.popups.set(pane.id, client.id);
    void this.emitEvent("popup.opened", {
      ...options.details,
      paneId: pane.id,
      clientId: client.id,
    });
    return { paneId: pane.id };
  }

  private closePopup(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane || !this.popups.has(paneId)) return;
    const clientId = this.popups.get(paneId);
    this.popups.delete(paneId);
    pane.close();
    this.panes.delete(paneId);
    this.finishPluginPane(paneId, pane.exitCode);
    void this.emitEvent("popup.closed", { paneId, clientId });
  }

  /** Working directory for a new pane: the focused pane's live cwd, falling
   * back to the workspace root. */
  private newPaneCwd(client: ClientState): string {
    const policy = this.config.terminal.new_cwd;
    if (policy === "home") return os.homedir();
    if (policy === "current") return process.cwd();
    if (policy !== "follow" && policy) {
      const expanded = policy.startsWith("~")
        ? path.join(os.homedir(), policy.slice(1))
        : policy;
      if (fs.existsSync(expanded)) return expanded;
    }
    const workspace = this.activeWorkspaceForClient(client);
    const tab = this.activeTabForClient(client);
    const focused = this.panes.get(tab.focusedPaneId);
    const candidates = [
      focused?.resolveCwd(),
      focused?.cwd,
      workspace.rootPath,
    ];
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return process.cwd();
  }

  private restorePlugins(): void {
    for (const entry of loadPluginRegistry(stateDirectory(this.session))) {
      try {
        const manifest = loadPluginManifest(entry.manifestPath);
        this.plugins.set(manifest.id, {
          manifest,
          enabled: entry.enabled,
        });
      } catch {
        // Missing or invalid local plugin manifests are omitted from the live
        // registry while their persisted entry remains intentionally intact.
      }
    }
  }

  private async refreshMarketplace(): Promise<unknown> {
    const result = await searchPluginMarketplace("", 50);
    const cache = {
      version: 1 as const,
      updatedAt: new Date().toISOString(),
      query: "",
      total: result.total,
      plugins: result.plugins,
    };
    saveMarketplaceCache(stateDirectory(this.session), cache);
    void this.emitEvent("marketplace.updated", {
      total: result.total,
      plugins: result.plugins.length,
    });
    return cache;
  }

  /** Brings machine links in line with machines.json. An unreadable file
   * leaves the current links alone; the next change retries. */
  private syncSavedMachines(): void {
    try {
      this.machines.sync(loadMachines());
    } catch {
      // Keep current connections until the file is valid again.
    }
  }

  /** Watches machines.json so `shepherd machine add/enable/...` apply to a
   * running daemon within about a second. */
  private watchSavedMachines(): void {
    if (this.watchingMachines) return;
    this.watchingMachines = true;
    fs.watchFile(
      machinesPath(),
      { interval: 1_000, persistent: false },
      () => this.syncSavedMachines(),
    );
  }

  /** Machine bridges stay open while a UI client is subscribed to events;
   * without one they close after a minute of disuse. */
  private updateMachineDemand(): void {
    this.machines.setDemand(
      [...this.clients].some((entry) => entry.subscribed && !entry.socket.destroyed),
    );
  }

  private persistPlugins(): void {
    savePluginRegistry(
      stateDirectory(this.session),
      [...this.plugins.values()].map((plugin) => ({
        manifestPath: plugin.manifest.manifestPath,
        enabled: plugin.enabled,
      })),
    );
  }

  private linkPlugin(inputPath: string): PluginView {
    const manifest = loadPluginManifest(inputPath);
    if (this.plugins.has(manifest.id)) {
      throw new Error(`plugin already linked: ${manifest.id}`);
    }
    assertPluginCompatible(manifest);
    ensurePluginDirectories(this.pluginRuntime(manifest.id));
    this.plugins.set(manifest.id, { manifest, enabled: true });
    this.persistPlugins();
    this.changed();
    return this.pluginView(manifest, true);
  }

  private unlinkPlugin(pluginId: string): { pluginId: string; removed: boolean } {
    const removed = this.plugins.delete(pluginId);
    if (!removed) throw new Error(`unknown plugin: ${pluginId}`);
    this.persistPlugins();
    this.changed();
    return { pluginId, removed };
  }

  /** Unregisters an installed (managed) plugin and deletes its checkout.
   * Locally linked plugins are only ever unlinked. */
  private uninstallPlugin(pluginId: string): {
    pluginId: string;
    removed: boolean;
    path: string;
  } {
    const plugin = this.requirePlugin(pluginId);
    const checkout = managedCheckoutFor(
      stateDirectory(this.session),
      plugin.manifest.root,
    );
    if (!checkout) {
      throw new Error(
        `plugin ${pluginId} is locally linked; use plugin unlink instead`,
      );
    }
    this.plugins.delete(pluginId);
    this.persistPlugins();
    fs.rmSync(checkout, { recursive: true, force: true });
    this.changed();
    return { pluginId, removed: true, path: checkout };
  }

  private setPluginEnabled(
    pluginId: string,
    enabled: boolean,
  ): PluginView {
    const plugin = this.requirePlugin(pluginId);
    plugin.enabled = enabled;
    this.persistPlugins();
    this.changed();
    return this.pluginView(plugin.manifest, enabled);
  }

  private async invokePlugin(
    pluginId: string,
    actionId: string,
    client?: ClientState,
    extraContext?: Record<string, unknown>,
  ): Promise<{
    pluginId: string;
    actionId: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    error: string | null;
    logId: string;
    log: PluginCommandLog;
    context: PluginInvocationContext;
  }> {
    const plugin = this.requirePlugin(pluginId);
    if (!plugin.enabled) throw new Error(`plugin is disabled: ${pluginId}`);
    const action = plugin.manifest.actions.find((entry) => entry.id === actionId);
    if (!action) throw new Error(`unknown plugin action: ${actionId}`);
    if (!supportsPlatform(action.platforms, plugin.manifest.platforms)) {
      throw new Error(`plugin action ${pluginId}.${actionId} does not support this platform`);
    }
    const context = this.pluginContext("api", client, extraContext);
    const { log, done } = this.startPluginCommand(plugin.manifest, {
      kind: "action",
      actionId: action.id,
      command: action.command,
      context,
      env: { SHEPHERD_PLUGIN_ACTION_ID: action.id },
      timeoutMs: PLUGIN_ACTION_TIMEOUT_MS,
    });
    const result = await done;
    const invocation = {
      pluginId,
      actionId,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      error: result.error,
      logId: log.logId,
    };
    void this.emitEvent("plugin.invoked", invocation);
    return { ...invocation, log: { ...log }, context };
  }

  /** Runs one plugin command in the background and records it in the
   * plugin log. `done` never rejects. */
  private startPluginCommand(
    manifest: PluginManifest,
    options: {
      kind: PluginCommandKind;
      command: string[];
      context: PluginInvocationContext;
      actionId?: string;
      event?: string;
      env?: Record<string, string>;
      stdin?: string;
      timeoutMs: number;
    },
  ): { log: PluginCommandLog; done: Promise<PluginCommandResult> } {
    const log = this.pluginLogs.start({
      pluginId: manifest.id,
      kind: options.kind,
      command: options.command,
      ...(options.actionId ? { actionId: options.actionId } : {}),
      ...(options.event ? { event: options.event } : {}),
    });
    const fail = (error: string): { log: PluginCommandLog; done: Promise<PluginCommandResult> } => {
      const result = { exitCode: null, stdout: "", stderr: "", timedOut: false, error };
      this.pluginLogs.finish(log, result);
      return { log, done: Promise.resolve(result) };
    };
    if (this.pluginCommandsInFlight >= MAX_PLUGIN_COMMANDS_IN_FLIGHT) {
      return fail(`maximum concurrent plugin commands reached (${MAX_PLUGIN_COMMANDS_IN_FLIGHT})`);
    }
    const runtime = this.pluginRuntime(manifest.id);
    try {
      ensurePluginDirectories(runtime);
    } catch (error) {
      return fail(`cannot create plugin directories: ${error instanceof Error ? error.message : String(error)}`);
    }
    const env = pluginEnvironment(manifest, runtime, options.context, options.env);
    this.pluginCommandsInFlight += 1;
    const done = runPluginCommand(manifest.root, options.command, env, {
      stdin: options.stdin,
      timeoutMs: options.timeoutMs,
    }).then((result) => {
      this.pluginLogs.finish(log, result);
      return result;
    }).finally(() => {
      this.pluginCommandsInFlight -= 1;
    });
    return { log, done };
  }

  private pluginRuntime(pluginId: string): PluginRuntime {
    return {
      socketPath: this.socketPath,
      binPath: process.argv[1] ?? process.execPath,
      configDirectory: pluginConfigDirectory(pluginId),
      stateDirectory: pluginStateDirectory(stateDirectory(this.session), pluginId),
    };
  }

  /** Invocation context from a client's selection (or the global one),
   * with `extra` fields (null values skipped) on top. */
  private pluginContext(
    source: string,
    client?: ClientState,
    extra?: Record<string, unknown>,
  ): PluginInvocationContext {
    const context: PluginInvocationContext = { invocation_source: source };
    try {
      const selection = client
        ? this.selectionForClient(client)
        : {
          workspaceId: this.activeWorkspaceId,
          tabId: this.activeTabId,
          focusedPaneId: this.focusedPaneId,
        };
      const workspace = this.workspaces.find((entry) => entry.id === selection.workspaceId);
      const tabIndex = workspace?.tabs.findIndex((entry) => entry.id === selection.tabId) ?? -1;
      const tab = tabIndex >= 0 ? workspace?.tabs[tabIndex] : undefined;
      const pane = this.panes.get(selection.focusedPaneId);
      if (workspace) {
        context.workspace_id = workspace.id;
        context.workspace_label = this.workspaceLabel(workspace);
        context.workspace_cwd = workspace.rootPath;
      }
      if (tab) {
        context.tab_id = tab.id;
        context.tab_label = tab.name || String(tabIndex + 1);
      }
      if (pane) {
        context.focused_pane_id = pane.id;
        context.focused_pane_cwd = pane.currentCwd;
        if (pane.agent) context.focused_pane_agent = pane.agent;
        context.focused_pane_status = pane.status;
      }
    } catch {
      // No selection yet (e.g. during startup); ids are simply absent.
    }
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (value !== null && value !== undefined) context[key] = value;
    }
    return context;
  }

  private enabledPlugins(): Array<{ manifest: PluginManifest; enabled: boolean }> {
    return [...this.plugins.values()]
      .filter((plugin) => plugin.enabled)
      .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  }

  private runStartupHooks(): void {
    for (const plugin of this.enabledPlugins()) {
      for (const hook of plugin.manifest.startup) {
        if (!supportsPlatform(hook.platforms, plugin.manifest.platforms)) continue;
        this.startPluginCommand(plugin.manifest, {
          kind: "startup",
          event: "startup",
          command: hook.command,
          context: this.pluginContext("startup"),
          env: { SHEPHERD_PLUGIN_EVENT: "startup" },
          timeoutMs: PLUGIN_HOOK_TIMEOUT_MS,
        });
      }
    }
  }

  private hasEventHooks(): boolean {
    for (const plugin of this.plugins.values()) {
      if (plugin.enabled && plugin.manifest.events.length > 0) return true;
    }
    return false;
  }

  /** Called for every daemon event: runs hooks on Shepherd's own events and
   * schedules a state diff for lifecycle events. */
  private onDaemonEvent(event: string, data: Record<string, unknown>): void {
    if (this.stopping || this.handingOff) return;
    if (!this.hasEventHooks()) {
      this.hookTracker = null;
      return;
    }
    if (DIRECT_HOOK_EVENTS.has(event)) {
      this.fireEventHooks(event, { event, data });
    }
    if (!this.hookTracker) {
      this.hookTracker = new PluginLifecycleTracker(this.stateView());
      return;
    }
    if (this.hookPollScheduled) return;
    this.hookPollScheduled = true;
    setImmediate(() => {
      this.hookPollScheduled = false;
      if (this.stopping || this.handingOff) return;
      if (!this.hasEventHooks()) {
        this.hookTracker = null;
        return;
      }
      if (!this.hookTracker) return;
      let events;
      try {
        events = this.hookTracker.poll(this.stateView());
      } catch {
        return;
      }
      for (const event of events) {
        this.fireEventHooks(event.name, { event: event.name, data: event.data });
      }
    });
  }

  /** Starts every enabled `[[events]]` hook listening to `name`. The event
   * JSON goes to SHEPHERD_PLUGIN_EVENT_JSON and to the command's stdin. */
  private fireEventHooks(
    name: string,
    envelope: { event: string; data: Record<string, unknown> },
  ): void {
    const json = JSON.stringify({ event: name, data: envelope.data });
    const data = envelope.data;
    const ids: Record<string, unknown> = {
      event: name,
      workspace_id: typeof data.workspace_id === "string" ? data.workspace_id : undefined,
      tab_id: typeof data.tab_id === "string" ? data.tab_id : undefined,
      focused_pane_id: typeof data.pane_id === "string"
        ? data.pane_id
        : typeof data.paneId === "string" ? data.paneId : undefined,
    };
    for (const plugin of this.enabledPlugins()) {
      for (const hook of plugin.manifest.events) {
        if (!hook.on.includes(name)) continue;
        if (!supportsPlatform(hook.platforms, plugin.manifest.platforms)) continue;
        this.startPluginCommand(plugin.manifest, {
          kind: "event",
          event: name,
          command: hook.command,
          context: this.pluginContext("event", undefined, ids),
          env: { SHEPHERD_PLUGIN_EVENT: name, SHEPHERD_PLUGIN_EVENT_JSON: json },
          stdin: `${json}\n`,
          timeoutMs: PLUGIN_HOOK_TIMEOUT_MS,
        });
      }
    }
  }

  /** Ctrl-click on a link: the first matching `[[link_handlers]]` entry
   * runs its action instead of the URL opening. */
  private openLinkWithPlugin(
    client: ClientState,
    url: string,
  ): {
    handled: boolean;
    pluginId?: string;
    handlerId?: string;
    actionId?: string;
    logId?: string;
  } {
    const match = matchLinkHandler(this.enabledPlugins(), url);
    if (!match) return { handled: false };
    const action = match.manifest.actions.find((entry) => entry.id === match.handler.action);
    if (!action || !supportsPlatform(action.platforms, match.manifest.platforms)) {
      return { handled: false };
    }
    const { log, done } = this.startPluginCommand(match.manifest, {
      kind: "action",
      actionId: action.id,
      command: action.command,
      context: this.pluginContext("link_click", client, {
        clicked_url: url,
        link_handler_id: match.handler.id,
      }),
      env: { SHEPHERD_PLUGIN_ACTION_ID: action.id },
      timeoutMs: PLUGIN_ACTION_TIMEOUT_MS,
    });
    void done.then((result) => {
      void this.emitEvent("plugin.invoked", {
        pluginId: match.manifest.id,
        actionId: action.id,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        error: result.error,
        logId: log.logId,
      });
    });
    return {
      handled: true,
      pluginId: match.manifest.id,
      handlerId: match.handler.id,
      actionId: action.id,
      logId: log.logId,
    };
  }

  /** Opens a `[[panes]]` entrypoint as a popup or as a real pane (split,
   * new tab, zoomed, or an overlay that restores focus and zoom when it
   * closes). */
  private async openPluginPane(
    client: ClientState,
    message: Extract<ShepherdRequest, { type: "plugin.pane-open" }>,
  ): Promise<{
    paneId: string;
    pluginId: string;
    entrypointId: string;
    placement: PluginPanePlacement;
    popup: boolean;
  }> {
    const plugin = this.requirePlugin(message.pluginId);
    if (!plugin.enabled) throw new Error(`plugin is disabled: ${message.pluginId}`);
    const manifest = plugin.manifest;
    const entry = manifest.panes.find((pane) => pane.id === message.entrypointId);
    if (!entry) {
      throw new Error(`unknown plugin pane entrypoint: ${manifest.id}.${message.entrypointId}`);
    }
    if (!supportsPlatform(entry.platforms, manifest.platforms)) {
      throw new Error(`plugin pane ${manifest.id}.${entry.id} does not support this platform`);
    }
    const placement = message.placement ?? entry.placement;
    const runtime = this.pluginRuntime(manifest.id);
    ensurePluginDirectories(runtime);
    const context = this.pluginContext("pane", client);
    const env = pluginEnvironment(manifest, runtime, context, {
      SHEPHERD_PLUGIN_ENTRYPOINT_ID: entry.id,
    });
    for (const [key, value] of Object.entries(message.env ?? {})) {
      if (typeof value === "string") env[key] = value;
    }
    const command = shellCommandLine(entry.command);
    const cwd = message.cwd ?? manifest.root;
    const record = (paneId: string, restore?: PluginPaneRecord["restore"]) => {
      const log = this.pluginLogs.start({
        pluginId: manifest.id,
        kind: "pane",
        entrypointId: entry.id,
        command: entry.command,
      });
      this.pluginPanes.set(paneId, {
        pluginId: manifest.id,
        entrypointId: entry.id,
        placement,
        log,
        ...(restore ? { restore } : {}),
      });
    };
    const result = (paneId: string) => ({
      paneId,
      pluginId: manifest.id,
      entrypointId: entry.id,
      placement,
      popup: placement === "popup",
    });

    if (placement === "popup") {
      const owner = this.popupOwner(client);
      const opened = this.openPopup(owner, command, cwd, {
        env,
        details: {
          pluginId: manifest.id,
          entrypointId: entry.id,
          title: entry.title,
          width: popupDimension(message.width ?? entry.width),
          height: popupDimension(message.height ?? entry.height),
        },
      });
      record(opened.paneId);
      return result(opened.paneId);
    }

    if (placement === "tab") {
      const workspace = message.workspaceId
        ? this.requireWorkspace(message.workspaceId)
        : this.activeWorkspaceForClient(client);
      const pane = this.spawnPane({ title: entry.title, command, cwd, env });
      const tab: RunningTab = {
        id: `t${this.nextTab}`,
        name: entry.title,
        layout: paneLayout(pane.id),
        focusedPaneId: pane.id,
        zoomedPaneId: null,
      };
      this.nextTab += 1;
      workspace.tabs.push(tab);
      record(pane.id);
      if (message.focus ?? true) {
        this.selectWorkspace(workspace);
        workspace.activeTabId = tab.id;
        this.activeTabId = tab.id;
        this.focusedPaneId = pane.id;
        client.selection = { workspaceId: workspace.id, tabId: tab.id, focusedPaneId: pane.id };
      }
      this.changed();
      return result(pane.id);
    }

    // split, zoomed and overlay: split next to the target pane.
    let targetPaneId: string;
    if (message.targetPaneId) {
      targetPaneId = message.targetPaneId;
      this.requirePane(targetPaneId);
    } else if (message.workspaceId) {
      const workspace = this.requireWorkspace(message.workspaceId);
      targetPaneId = this.requireTab(workspace.activeTabId).focusedPaneId;
    } else {
      targetPaneId = this.selectionForClient(client).focusedPaneId;
    }
    const tab = this.requireTabByPane(targetPaneId);
    const restore = placement === "overlay"
      ? { tabId: tab.id, focusedPaneId: tab.focusedPaneId, zoomedPaneId: tab.zoomedPaneId }
      : undefined;
    const pane = this.spawnPane({ title: entry.title, command, cwd, env });
    tab.layout = splitPane(tab.layout, targetPaneId, pane.id, message.direction ?? "right");
    tab.zoomedPaneId = placement === "split" ? null : pane.id;
    record(pane.id, restore);
    this.changed();
    const focus = placement === "split" ? message.focus ?? true : true;
    if (focus) await this.dispatch(client, { id: "", type: "pane.focus", paneId: pane.id });
    return result(pane.id);
  }

  private requirePluginPane(paneId: string): PluginPaneRecord {
    const record = this.pluginPanes.get(paneId);
    if (!record || !this.panes.has(paneId)) {
      throw new Error(`unknown plugin pane: ${paneId}`);
    }
    return record;
  }

  private async focusPluginPane(client: ClientState, paneId: string): Promise<{
    paneId: string;
    pluginId: string;
    entrypointId: string;
    placement: PluginPanePlacement;
    popup: boolean;
  }> {
    const record = this.requirePluginPane(paneId);
    const popup = this.popups.has(paneId);
    if (!popup) {
      const tab = this.requireTabByPane(paneId);
      if (record.placement === "overlay" || record.placement === "zoomed") {
        tab.zoomedPaneId = paneId;
      }
      await this.dispatch(client, { id: "", type: "pane.focus", paneId });
    }
    return {
      paneId,
      pluginId: record.pluginId,
      entrypointId: record.entrypointId,
      placement: record.placement,
      popup,
    };
  }

  private closePluginPane(paneId: string): { paneId: string; closed: boolean } {
    this.requirePluginPane(paneId);
    if (this.popups.has(paneId)) this.closePopup(paneId);
    else this.closePane(paneId);
    return { paneId, closed: true };
  }

  /** Records a plugin pane's end in its log entry. */
  private finishPluginPane(paneId: string, exitCode: number | null): PluginPaneRecord | undefined {
    const record = this.pluginPanes.get(paneId);
    if (!record) return undefined;
    this.pluginPanes.delete(paneId);
    this.pluginLogs.finish(record.log, {
      exitCode: exitCode ?? 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      error: null,
    });
    return record;
  }

  /** The attached UI that shows a plugin popup: the requesting client when
   * it displays panes, else the most recently attached one. */
  private popupOwner(client: ClientState): ClientState {
    const attached = (entry: ClientState) =>
      entry.subscribed && !entry.socket.destroyed && entry.surfaces.size > 0;
    if (attached(client)) return client;
    const candidates = [...this.clients].filter(attached);
    const owner = candidates[candidates.length - 1];
    if (!owner) throw new Error("no_foreground_client: no attached client to show the popup");
    return owner;
  }

  private pluginView(manifest: PluginManifest, enabled: boolean, id = manifest.id): PluginView {
    const view = pluginView(manifest, enabled, id);
    view.managed = managedCheckoutFor(stateDirectory(this.session), manifest.root) !== null;
    try {
      view.configDir = pluginConfigDirectory(id);
    } catch {
      // Ids from older registries may not map to a directory.
    }
    return view;
  }

  private requirePlugin(pluginId: string): {
    manifest: PluginManifest;
    enabled: boolean;
  } {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`unknown plugin: ${pluginId}`);
    return plugin;
  }

  private requirePane(paneId: string): PaneTerminal {
    const pane = this.panes.get(paneId);
    if (!pane) throw new Error(`unknown pane: ${paneId}`);
    return pane;
  }

  private requireTab(tabId: string): RunningTab {
    const tab = this.allTabs().find((entry) => entry.id === tabId);
    if (!tab) throw new Error(`unknown tab: ${tabId}`);
    return tab;
  }

  private requireTabByPane(paneId: string): RunningTab {
    const tab = this.allTabs().find((entry) => paneIds(entry.layout).includes(paneId));
    if (!tab) throw new Error(`unknown pane tab: ${paneId}`);
    return tab;
  }

  private requireWorkspace(workspaceId: string): RunningWorkspace {
    const workspace = this.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) throw new Error(`unknown workspace: ${workspaceId}`);
    return workspace;
  }

  private requireWorkspaceByTab(tabId: string): RunningWorkspace {
    const workspace = this.workspaces.find((entry) =>
      entry.tabs.some((tab) => tab.id === tabId)
    );
    if (!workspace) throw new Error(`unknown tab workspace: ${tabId}`);
    return workspace;
  }

  private activeWorkspace(): RunningWorkspace {
    return this.requireWorkspace(this.activeWorkspaceId);
  }

  private activeTab(): RunningTab {
    return this.requireTab(this.activeWorkspace().activeTabId);
  }

  private selectionForClient(client: ClientState): NonNullable<ClientState["selection"]> {
    if (!client.selection) {
      const workspace = this.activeWorkspace();
      const tab = this.requireTab(workspace.activeTabId);
      client.selection = {
        workspaceId: workspace.id,
        tabId: tab.id,
        focusedPaneId: tab.focusedPaneId,
      };
    }
    return client.selection;
  }

  private activeWorkspaceForClient(client: ClientState): RunningWorkspace {
    const selection = this.selectionForClient(client);
    return this.requireWorkspace(selection.workspaceId);
  }

  private activeTabForClient(client: ClientState): RunningTab {
    const selection = this.selectionForClient(client);
    return this.requireTab(selection.tabId);
  }

  private selectWorkspaceForClient(
    client: ClientState,
    workspace: RunningWorkspace,
  ): void {
    const tab = workspace.tabs.find((entry) => entry.id === workspace.activeTabId)
      ?? workspace.tabs[0];
    if (!tab) throw new Error(`workspace has no tabs: ${workspace.id}`);
    this.selectWorkspace(workspace);
    client.selection = {
      workspaceId: workspace.id,
      tabId: tab.id,
      focusedPaneId: tab.focusedPaneId,
    };
  }

  private selectTabForClient(
    client: ClientState,
    workspace: RunningWorkspace,
    tab: RunningTab,
  ): void {
    workspace.activeTabId = tab.id;
    this.activeWorkspaceId = workspace.id;
    this.activeTabId = tab.id;
    this.focusedPaneId = tab.focusedPaneId;
    client.selection = {
      workspaceId: workspace.id,
      tabId: tab.id,
      focusedPaneId: tab.focusedPaneId,
    };
  }

  private normalizeClientSelection(client: ClientState): void {
    if (!client.selection) return;
    const workspace = this.workspaces.find((entry) =>
      entry.id === client.selection?.workspaceId
    );
    if (!workspace || workspace.tabs.length === 0) {
      client.selection = null;
      this.selectionForClient(client);
      return;
    }
    const tab = workspace.tabs.find((entry) =>
      entry.id === client.selection?.tabId
    ) ?? workspace.tabs[0];
    if (!tab) return;
    const paneId = paneIds(tab.layout).includes(
      client.selection.focusedPaneId,
    )
      ? client.selection.focusedPaneId
      : tab.focusedPaneId;
    client.selection = {
      workspaceId: workspace.id,
      tabId: tab.id,
      focusedPaneId: paneId,
    };
  }

  private normalizeClientSelections(): void {
    for (const client of this.clients) this.normalizeClientSelection(client);
  }

  private allTabs(): RunningTab[] {
    return this.workspaces.flatMap((workspace) => workspace.tabs);
  }

  private resolveAgentOrPane(
    client: ClientState,
    target: string,
  ): PaneView {
    const panes = this.stateViewForClient(client).panes;
    const byId = panes.find((pane) => pane.id === target);
    if (byId) return byId;
    const byAgent = panes.filter((pane) => pane.agent === target);
    if (byAgent.length === 1) return byAgent[0];
    if (byAgent.length > 1) {
      throw new Error(`multiple agents named ${target}; use a pane ID`);
    }
    throw new Error(`unknown agent or pane: ${target}`);
  }

  /** Shepherd's detection cadence: every 300 ms, or 100 ms while a pane is
   * confirming a working → idle change. */
  private scheduleDetection(): void {
    if (this.stopping) return;
    const pending = [...this.panes.values()].some((pane) =>
      pane.detector.pendingConfirmation
    );
    this.agentStatusTimer = setTimeout(() => {
      const now = Date.now();
      for (const [id, pane] of this.panes) {
        if (this.popups.has(id)) continue;
        pane.detect(now, this.completionSuppressed(id));
      }
      this.publishAgentStatuses();
      this.scheduleDetection();
    }, pending ? 100 : 300);
    this.agentStatusTimer.unref?.();
  }

  /** A completion is not news when a client is showing the pane and its
   * terminal has focus (Shepherd's active-tab suppression). */
  private completionSuppressed(paneId: string): boolean {
    for (const client of this.clients) {
      if (client.hostFocused && client.surfaces.has(paneId)) return true;
    }
    return false;
  }

  /** Clears "done" for panes a focused client is now showing. */
  private markVisibleSeen(client: ClientState): void {
    if (!client.hostFocused) return;
    let changed = false;
    for (const paneId of client.surfaces.keys()) {
      if (this.panes.get(paneId)?.detector.markSeen()) changed = true;
    }
    if (changed) this.publishAgentStatuses();
  }

  private publishAgentStatuses(): void {
    let tasksChanged = false;
    for (const [id, pane] of this.panes) {
      const completions = pane.detector.completionSequence;
      if (completions > (this.agentCompletions.get(id) ?? 0)) {
        pane.task = updateTask(pane.task, { review: "requested" }, "status observation");
        tasksChanged = true;
      }
      this.agentCompletions.set(id, completions);
      const previous = this.agentStatuses.get(id);
      if (previous === pane.status) continue;
      this.agentStatuses.set(id, pane.status);
      if (pane.agent) {
        void this.emitEvent("agent.status.changed", {
          paneId: id,
          agent: pane.agent,
          previous: previous ?? "unknown",
          status: pane.status,
        });
      }
    }
    for (const id of this.agentStatuses.keys()) {
      if (!this.panes.has(id)) { this.agentStatuses.delete(id); this.agentCompletions.delete(id); }
    }
    if (tasksChanged) { this.persist(); this.changed(); }
  }

  private stateView(): StateView {
    const activeWorkspace = this.activeWorkspace();
    const panes: PaneView[] = [...this.panes.values()].map((pane) => {
      return {
        id: pane.id,
        title: pane.title,
        command: pane.command,
        cwd: pane.currentCwd,
        agent: pane.agent,
        status: pane.status,
        exitCode: pane.exitCode,
        updatedAt: new Date(pane.lastOutputAt).toISOString(),
        terminalTitle: pane.terminalTitle,
        signal: pane.detector.signal(),
        task: pane.task,
        continuity: pane.continuity,
        ...metadataView(pane.metadata),
        modes: pane.modes,
      };
    });
    const tabs: TabView[] = activeWorkspace.tabs.map((tab) => ({
      id: tab.id,
      name: tab.name,
      layout: tab.layout,
      zoomedPaneId: tab.zoomedPaneId,
    }));
    const workspaces: WorkspaceView[] = this.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      label: this.workspaceLabel(workspace),
      tokens: this.workspaceMetadata.get(workspace.id)?.effective().tokens ?? {},
      git: this.gitStatuses.get(workspace.id) ?? null,
      rootPath: workspace.rootPath,
      activeTabId: workspace.activeTabId,
      tabs: workspace.tabs.map((tab) => ({
        id: tab.id,
        name: tab.name,
        layout: tab.layout,
        zoomedPaneId: tab.zoomedPaneId,
      })),
    }));
    const plugins: PluginView[] = [...this.plugins.entries()].map(([id, plugin]) =>
      this.pluginView(plugin.manifest, plugin.enabled, id)
    );
    const machines: RemoteMachineView[] = this.machines.views();

    return {
      protocolVersion: 1,
      session: this.session,
      serverPid: process.pid,
      tabs,
      workspaces,
      activeWorkspaceId: activeWorkspace.id,
      activeTabId: this.activeTabId,
      focusedPaneId: this.focusedPaneId,
      panes,
      plugins,
      machines,
      stateVersion: this.stateVersion,
      agentView: this.agentView,
    };
  }

  private stateViewForClient(client: ClientState): StateView {
    const selection = this.selectionForClient(client);
    const workspace = this.requireWorkspace(selection.workspaceId);
    const tab = this.requireTab(selection.tabId);
    const base = this.stateView();
    return {
      ...base,
      clientId: client.id,
      tabs: workspace.tabs.map((entry) => ({
        id: entry.id,
        name: entry.name,
        layout: entry.layout,
        zoomedPaneId: entry.zoomedPaneId,
      })),
      workspaces: base.workspaces.map((entry) => ({
        ...entry,
        activeTabId: entry.id === workspace.id ? tab.id : entry.activeTabId,
      })),
      activeWorkspaceId: workspace.id,
      activeTabId: tab.id,
      focusedPaneId: selection.focusedPaneId,
    };
  }

  private restore(): void {
    const saved = loadState(this.session);
    if (!saved) return;
    const history = this.config.experimental.pane_history
      ? loadHistory(this.session, saved)
      : null;

    this.nextWorkspace = 1;
    this.nextTab = 1;
    this.nextPane = 1;
    const idTranslations = new Map<string, string>();

    let resumed = 0;
    for (const savedPane of saved.panes) {
      const available = fs.existsSync(savedPane.cwd);
      const resume = !savedPane.completed && this.config.session.resume_agents_on_restore && savedPane.agentSession
        ? resumeArgv(savedPane.agentSession)
        : null;
      const pane = this.spawnPane({
        title: savedPane.title,
        // A resume is sent to a fresh shell below. Launching the original
        // agent first would feed the resume command into its prompt instead.
        command: savedPane.completed || resume ? null : savedPane.command,
        // A resumed agent session replaces the saved screen, as in Shepherd.
        replay: resume ? undefined : history?.panes[savedPane.id],
        cwd: available ? savedPane.cwd : os.homedir(),
        notice: available
          ? undefined
          : `Saved directory ${savedPane.cwd} is unavailable; started in your home directory.`,
      });
      if (resume && savedPane.agentSession) {
        // Resume into the pane's shell, staggered like Shepherd's
        // startup_per_agent_delay_ms, so the shell remains afterwards.
        pane.agentSession = savedPane.agentSession;
        const delay = 300 + resumed * this.config.session.startup_per_agent_delay_ms;
        resumed += 1;
        const command = shellCommand(resume);
        setTimeout(() => pane.write(`${command}\r`), delay).unref?.();
      }
      pane.task = savedPane.task ?? null;
      pane.continuity = resume ? "resuming" : "restarted";
      idTranslations.set(savedPane.id, pane.id);
    }

    this.workspaces = saved.workspaces.map((workspace) => {
      const tabs = workspace.tabs.map((tab) => {
        const layout = translatePaneIds(tab.layout, idTranslations);
        const ids = paneIds(layout);
        return {
          ...tab,
          layout,
          rootPaneId: tab.rootPaneId ? idTranslations.get(tab.rootPaneId) : undefined,
          zoomedPaneId: tab.zoomedPaneId
            ? idTranslations.get(tab.zoomedPaneId) ?? null
            : null,
          focusedPaneId:
            ids.find((paneId) => paneId === idTranslations.get(tab.focusedPaneId)) ??
            ids[0] ??
            "",
        };
      }).filter((tab) => paneIds(tab.layout).length > 0);
      return {
        ...workspace,
        rootPath: workspace.rootPath ?? process.cwd(),
        tabs,
        activeTabId: tabs.some((tab) => tab.id === workspace.activeTabId)
          ? workspace.activeTabId
          : tabs[0]?.id ?? "",
      };
    }).filter((workspace) => workspace.tabs.length > 0);

    this.normalizeIdCounters();
    const activeWorkspace = this.workspaces.find(
      (workspace) => workspace.id === saved.activeWorkspaceId,
    ) ?? this.workspaces[0];
    if (activeWorkspace) this.selectWorkspace(activeWorkspace);
  }

  private persist(): void {
    if (this.workspaces.length === 0 || this.handingOff) return;
    const snapshot = this.persistedSnapshot();
    // Only touch the disk when something actually changed.
    const encoded = JSON.stringify(snapshot);
    if (encoded === this.lastPersisted) return;
    saveState(this.session, snapshot);
    this.lastPersisted = encoded;
  }

  /** Saves pane screen history when experimental.pane_history is on (at
   * most every 10 seconds unless forced), and removes it when off. */
  private persistHistory(force = false): void {
    if (this.handingOff || (this.stopping && !force)) return;
    if (!this.config.experimental.pane_history) {
      if (this.historySavedAt !== -1) {
        removeHistory(this.session);
        this.historySavedAt = -1;
      }
      return;
    }
    if (this.workspaces.length === 0) return;
    const revision = [...this.panes.values()].reduce((total, pane) => total + pane.revision, 0);
    const now = Date.now();
    if (!force && (revision === this.historyRevision || now - this.historySavedAt < 10_000)) return;
    const snapshot = this.persistedSnapshot();
    const panes: Record<string, string> = {};
    for (const pane of this.panes.values()) {
      const ansi = pane.historyAnsi();
      if (ansi) panes[pane.id] = ansi;
    }
    try {
      saveHistory(this.session, { version: 1, layoutFingerprint: layoutFingerprint(snapshot), panes });
      this.historySavedAt = now;
      this.historyRevision = revision;
    } catch {
      // History is best effort; the session itself was saved.
    }
  }

  private persistedSnapshot(): Parameters<typeof saveState>[1] {
    return {
      version: 2,
      activeWorkspaceId: this.activeWorkspaceId,
      workspaces: this.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        rootPath: workspace.rootPath,
        activeTabId: workspace.activeTabId,
        tabs: workspace.tabs.map((tab) => ({
          id: tab.id,
          name: tab.name,
          layout: tab.layout,
          rootPaneId: tab.rootPaneId,
          focusedPaneId: tab.focusedPaneId,
          zoomedPaneId: tab.zoomedPaneId,
        })),
      })),
      panes: [...this.panes.values()].map((pane) => ({
        id: pane.id,
        title: pane.title,
        command: pane.command,
        cwd: pane.currentCwd,
        task: pane.task,
        completed: pane.exitCode !== null,
        // Only keep a session while its agent is still in the pane.
        agentSession: pane.agentSession && pane.agent === pane.agentSession.agent
          ? pane.agentSession
          : null,
      })),
    };
  }

  private changed(): void {
    if (this.syncWorkspaceDirectories()) void this.refreshGitStatus();
    this.stateVersion += 1;
    void this.emitEvent("state.changed", {
      stateVersion: this.stateVersion,
    });
  }

  private async emitEvent(
    event: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const frame: EventFrame = {
      event,
      data,
      emittedAt: new Date().toISOString(),
    };
    const encoded = encodeMessage(frame);

    for (const waiter of this.eventWaiters) {
      if (waiter.event !== undefined && waiter.event !== event) continue;
      clearTimeout(waiter.timer);
      this.eventWaiters.delete(waiter);
      waiter.resolve(frame);
    }

    for (const client of this.clients) {
      if (!client.subscribed || client.socket.destroyed) continue;
      client.socket.write(encoded);
    }
    this.onDaemonEvent(event, data);
  }

  private waitForEvent(
    event: string | undefined,
    timeoutMs: number | undefined,
  ): Promise<EventFrame> {
    return new Promise((resolve, reject) => {
      const waiter: EventWaiter = {
        event,
        resolve,
        timer: setTimeout(() => {
          this.eventWaiters.delete(waiter);
          reject(new Error(
            timeoutMs === undefined
              ? "event wait timed out"
              : `event wait timed out after ${timeoutMs}ms`,
          ));
        }, timeoutMs ?? 30_000),
      };
      this.eventWaiters.add(waiter);
    });
  }

  private async waitForPaneStatus(
    paneId: string,
    statuses: string[],
    timeoutMs: number | undefined,
  ): Promise<unknown> {
    const pane = this.requirePane(paneId);
    const wanted = new Set(statuses);
    const deadline = timeoutMs === undefined
      ? Number.POSITIVE_INFINITY
      : Date.now() + Math.max(0, timeoutMs);

    for (;;) {
      const initialIdle = pane.status === "idle" &&
        wanted.has("idle") &&
        !pane.hasObservedStatusChange();
      if ((wanted.size === 0 || wanted.has(pane.status)) && !initialIdle) {
        return {
          paneId,
          status: pane.status,
          timedOut: false,
          exitCode: pane.exitCode,
        };
      }
      if (Date.now() >= deadline) {
        return {
          paneId,
          status: pane.status,
          timedOut: true,
          exitCode: pane.exitCode,
        };
      }
      await sleep(100);
    }
  }

  private normalizeIdCounters(): void {
    this.nextWorkspace = Math.max(
      1,
      ...this.workspaces.map((workspace) => numericSuffix(workspace.id, "w") + 1),
    );
    this.nextTab = Math.max(
      1,
      ...this.allTabs().map((tab) => numericSuffix(tab.id, "t") + 1),
    );
    this.nextPane = Math.max(
      1,
      ...[...this.panes.keys()].map((paneId) => numericSuffix(paneId, "p") + 1),
    );
  }
}

function pluginView(
  manifest: PluginManifest,
  enabled: boolean,
  id = manifest.id,
): PluginView {
  const view: PluginView = {
    id,
    name: manifest.name,
    version: manifest.version,
    manifestPath: manifest.manifestPath,
    root: manifest.root,
    enabled,
    actions: manifest.actions,
    builds: manifest.builds,
    startup: manifest.startup,
    events: manifest.events,
    panes: manifest.panes,
    linkHandlers: manifest.linkHandlers,
    warnings: manifest.warnings,
  };
  if (manifest.description) view.description = manifest.description;
  if (manifest.minShepherdVersion) view.minShepherdVersion = manifest.minShepherdVersion;
  if (manifest.platforms) view.platforms = manifest.platforms;
  return view;
}

/** Popup size for the client: cells or "NN%", defaulting to half size. */
function popupDimension(value: PluginPaneSize | undefined): string {
  if (value === undefined) return "50%";
  return typeof value === "number" ? String(value) : value;
}

function translatePaneIds(
  node: LayoutNode,
  translations: Map<string, string>,
): LayoutNode {
  if (node.kind === "pane") {
    return {
      kind: "pane",
      paneId: translations.get(node.paneId) ?? node.paneId,
    };
  }
  return {
    ...node,
    first: translatePaneIds(node.first, translations),
    second: translatePaneIds(node.second, translations),
  };
}

/** Virtual area for server-side geometry; layout is ratio based, so only
 * relative positions matter. */
const LAYOUT_AREA = { x: 0, y: 0, width: 1000, height: 1000 };

interface HandoffPayload {
  version: 1;
  state: Parameters<typeof saveState>[1];
  panes: Array<{
    id: string;
    fdIndex: number;
    pid: number;
    cols: number;
    rows: number;
    title: string;
    command: string | null;
    cwd: string;
    replay: string;
  }>;
}

/** Waits until something accepts connections on a socket path. */
async function waitForSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect(socketPath);
      socket.once("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function metadataView(store: MetadataStore): Pick<
  PaneView,
  "metadataTitle" | "displayAgent" | "stateLabels" | "tokens"
> {
  const effective = store.effective();
  return {
    metadataTitle: effective.title,
    displayAgent: effective.displayAgent,
    stateLabels: effective.stateLabels,
    tokens: effective.tokens,
  };
}

function expandHome(value: string): string {
  return value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function focusTabPane(tab: RunningTab, paneId: string): void {
  if (tab.focusedPaneId && tab.focusedPaneId !== paneId) {
    tab.focusHistory = [
      tab.focusedPaneId,
      ...(tab.focusHistory ?? []).filter(
        (entry) => entry !== tab.focusedPaneId && entry !== paneId,
      ),
    ].slice(0, 32);
  }
  tab.focusedPaneId = paneId;
}

function commandLabel(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "command";
}

function normalizeName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized.slice(0, 80) : "untitled";
}

function numericSuffix(value: string, prefix: string): number {
  if (!value.startsWith(prefix)) return 0;
  const suffix = Number.parseInt(value.slice(prefix.length), 10);
  return Number.isFinite(suffix) ? suffix : 0;
}

function requiredAliasString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("invalid request parameter");
  }
  return value;
}

function optionalAliasString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return path.join(
      fs.realpathSync(path.dirname(resolved)),
      path.basename(resolved),
    );
  }
}

function requiredAliasLayout(value: unknown): LayoutNode {
  if (!isAliasLayout(value)) {
    throw new Error("invalid layout");
  }
  return value;
}

function isAliasLayout(value: unknown): value is LayoutNode {
  if (typeof value !== "object" || value === null) return false;
  const node = value as Partial<LayoutNode>;
  if (node.kind === "pane") return typeof node.paneId === "string";
  if (node.kind !== "split") return false;
  return (
    (node.direction === "right" || node.direction === "down") &&
    typeof node.ratio === "number" &&
    isAliasLayout(node.first) &&
    isAliasLayout(node.second)
  );
}

function sanitizeAppliedLayout(node: LayoutNode): LayoutNode {
  if (node.kind === "pane") return { kind: "pane", paneId: node.paneId };
  return {
    kind: "split",
    direction: node.direction,
    ratio: Number.isFinite(node.ratio)
      ? Math.min(0.8, Math.max(0.2, node.ratio))
      : 0.5,
    first: sanitizeAppliedLayout(node.first),
    second: sanitizeAppliedLayout(node.second),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
