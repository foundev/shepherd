/** Persistent bridges to saved SSH machines.
 *
 * Each enabled machine gets one `MachineLink`: an ssh child running the
 * remote `shepherd server bridge`, over which the daemon speaks the normal
 * NDJSON protocol to the remote daemon. The link subscribes to the remote
 * event stream to keep a copy of the remote state (for the sidebar), health
 * checks quiet connections, and reconnects with backoff. All links share
 * one ssh ControlMaster per destination, so reconnects and `machine exec`
 * commands skip authentication. */
import { spawn } from "node:child_process";
import type { Duplex } from "node:stream";
import { ClientConnection } from "../client/connection.js";
import {
  findMachine,
  machineEnabled,
  sshTarget,
  type SavedMachine,
  type SavedMachineFile,
} from "../machines.js";
import { openChildBridge, ChildStream } from "../remote/bridge.js";
import {
  bridgeCommand,
  cachedExecutable,
  discoverRemoteShepherd,
  needsAttention,
  rememberExecutable,
} from "../remote/remoteCommand.js";
import { sshInvocation, type SshEndpoint } from "../remote/ssh.js";
import type {
  EventFrame,
  MachineStatus,
  PaneView,
  ReadSource,
  RemoteAgentOperationResult,
  RemoteMachineView,
  ShepherdRequest,
  StateView,
  TerminalLine,
} from "../types.js";

export const RECONNECT_INITIAL_MS = 1_000;
export const RECONNECT_MAX_MS = 120_000;
/** A connection must stay up this long before a drop gets a fast retry. */
export const HEALTHY_RESET_MS = 60_000;
/** Close a machine's bridge after this long with nothing using it. */
export const IDLE_CLOSE_MS = 60_000;
export const HEALTH_INTERVAL_MS = 20_000;
export const HEALTH_TIMEOUT_MS = 10_000;

/** Next reconnect delay. Doubles up to two minutes; only a connection that
 * stayed healthy for a minute earns a fast retry again. */
export function nextReconnectDelay(
  previousMs: number,
  healthyForMs: number,
): number {
  if (healthyForMs >= HEALTHY_RESET_MS || previousMs <= 0) return RECONNECT_INITIAL_MS;
  return Math.min(RECONNECT_MAX_MS, previousMs * 2);
}

export class AttentionError extends Error {}

export interface MachineLinkOptions {
  /** Called whenever the view changes. */
  changed: () => void;
  manageSshConfig: () => boolean;
  /** Opens a handshaken bridge stream; defaults to ssh. Tests substitute a
   * local child process. */
  openBridge?: (machine: SavedMachine, link: MachineLink) => Promise<Duplex>;
}

export class MachineLink {
  machine: SavedMachine;
  status: MachineStatus;
  error: string | null = null;
  checkedAt: string | null = null;
  remoteState: StateView | null = null;
  private connection: ClientConnection | null = null;
  private connecting: Promise<void> | null = null;
  private delay = 0;
  private connectedAt = 0;
  private lastUsed = 0;
  private demanded = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private executable: string | null = null;
  private waiters: Array<() => void> = [];
  private stopped = false;

  constructor(machine: SavedMachine, private readonly options: MachineLinkOptions) {
    this.machine = machine;
    this.status = machineEnabled(machine) ? "idle" : "disabled";
  }

  get endpoint(): SshEndpoint {
    return { user: this.machine.user, host: this.machine.host, port: this.machine.port };
  }

  /** Whether a UI client wants live machine state. */
  setDemand(demanded: boolean): void {
    this.demanded = demanded;
    if (demanded) this.ensureStarted();
    this.scheduleIdleCheck();
  }

  /** Updates the profile. A changed destination or session reconnects. */
  update(machine: SavedMachine): void {
    const reconnect = machine.host !== this.machine.host ||
      machine.user !== this.machine.user ||
      machine.port !== this.machine.port ||
      (machine.remoteSession ?? null) !== (this.machine.remoteSession ?? null);
    const wasEnabled = machineEnabled(this.machine);
    this.machine = machine;
    if (!machineEnabled(machine)) {
      this.disconnect("disabled");
      this.options.changed();
      return;
    }
    if (!wasEnabled || reconnect) {
      this.executable = reconnect ? null : this.executable;
      this.disconnect("idle");
      if (this.demanded) this.ensureStarted();
    }
    this.options.changed();
  }

  /** Starts connecting unless connected, connecting, or waiting for the
   * user (attention). */
  ensureStarted(): void {
    if (this.stopped || !machineEnabled(this.machine)) return;
    if (this.connection || this.connecting || this.retryTimer) return;
    if (this.status === "attention") return;
    void this.connect();
  }

  /** Sends a request to the remote daemon, connecting first if needed. An
   * explicit use also retries a machine that needs attention. */
  async request(request: ShepherdRequest | Record<string, unknown>, timeoutMs = 20_000): Promise<unknown> {
    const connection = await this.ready(Math.min(timeoutMs, 30_000));
    this.touch();
    return connection.request(request as ShepherdRequest, timeoutMs);
  }

  /** Re-reads the remote state now. */
  async refresh(): Promise<void> {
    await this.ready(30_000);
    this.touch();
    await this.refreshState();
  }

  view(): RemoteMachineView {
    const state = this.remoteState;
    return {
      id: this.machine.id,
      label: this.machine.label,
      target: sshTarget(this.machine),
      port: this.machine.port,
      checkedAt: this.checkedAt,
      reachable: this.status === "online",
      error: this.error,
      status: this.status,
      enabled: machineEnabled(this.machine),
      remoteSession: this.machine.remoteSession ?? null,
      remote: state ? summarizeRemoteState(state) : null,
    };
  }

  stop(): void {
    this.stopped = true;
    this.disconnect(this.status);
    for (const timer of [this.idleTimer, this.refreshTimer]) if (timer) clearTimeout(timer);
  }

  private touch(): void {
    this.lastUsed = Date.now();
    this.scheduleIdleCheck();
  }

  private async ready(timeoutMs: number): Promise<ClientConnection> {
    if (!machineEnabled(this.machine)) throw new Error(`machine ${this.machine.label} is disabled`);
    if (this.connection && this.status === "online") return this.connection;
    this.lastUsed = Date.now();
    if (this.status === "attention" && !this.connecting) {
      this.status = "connecting";
      this.error = null;
    }
    if (this.retryTimer) {
      // An explicit use retries now rather than waiting out the backoff.
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (!this.connecting && !this.connection) void this.connect();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== done);
        reject(new Error(this.error ?? `machine ${this.machine.label} is not connected`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        if (this.connection && this.status === "online") resolve();
        else reject(new Error(this.error ?? `machine ${this.machine.label} is not connected`));
      };
      this.waiters.push(done);
    });
    if (!this.connection) throw new Error(`machine ${this.machine.label} is not connected`);
    return this.connection;
  }

  private settleWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  private connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
      this.settleWaiters();
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    this.status = this.remoteState || this.delay > 0 ? "reconnecting" : "connecting";
    this.options.changed();
    let stream: Duplex;
    try {
      stream = this.options.openBridge
        ? await this.options.openBridge(this.machine, this)
        : await this.openSshBridge();
    } catch (error) {
      if (this.stopped) return;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof AttentionError) {
        this.status = "attention";
        this.error = message;
        this.options.changed();
        return;
      }
      this.scheduleRetry(message);
      return;
    }
    if (this.stopped || !machineEnabled(this.machine)) {
      stream.destroy();
      return;
    }
    const connection = ClientConnection.open(stream, (event) => this.onEvent(event));
    this.connection = connection;
    stream.once("close", () => {
      if (this.connection !== connection) return;
      this.connection = null;
      this.stopHealth();
      if (this.stopped || !machineEnabled(this.machine) || this.status === "idle") return;
      const detail = stream instanceof ChildStream ? stream.lastError() : "";
      if (stream instanceof ChildStream && stream.exitCode === 255 && needsAttention(stream.stderrText)) {
        this.status = "attention";
        this.error = detail;
        this.options.changed();
        return;
      }
      this.scheduleRetry(detail || "connection lost");
    });
    try {
      await connection.request({ type: "events.subscribe" }, 10_000);
      await this.refreshState();
    } catch (error) {
      if (this.connection === connection) {
        this.connection = null;
        connection.close();
        this.scheduleRetry(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    this.connectedAt = Date.now();
    this.status = "online";
    this.error = null;
    this.startHealth();
    this.scheduleIdleCheck();
    this.options.changed();
  }

  private async openSshBridge(): Promise<Duplex> {
    const sshOptions = {
      manage: this.options.manageSshConfig(),
      control: "shared" as const,
      batch: true,
    };
    this.executable ??= cachedExecutable(this.machine.id);
    if (!this.executable) {
      const discovery = await discoverRemoteShepherd(this.endpoint, sshOptions);
      if (discovery.status === "missing") {
        throw new AttentionError(
          `shepherd is not installed on ${sshTarget(this.machine)}; install it there and refresh`,
        );
      }
      if (discovery.status === "ssh-error") {
        if (discovery.attention) throw new AttentionError(discovery.message);
        throw new Error(discovery.message);
      }
      this.executable = discovery.path;
      rememberExecutable(this.machine.id, discovery.path);
    }
    const { command, args } = sshInvocation(
      this.endpoint,
      bridgeCommand(this.executable, this.machine.remoteSession ?? null),
      { ...sshOptions, tty: "disable" },
    );
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    try {
      return await openChildBridge(child, 30_000);
    } catch (error) {
      if (child.exitCode === 127) {
        // The remembered executable is gone; discover it again next time.
        this.executable = null;
        rememberExecutable(this.machine.id, null);
      }
      if (child.exitCode === 255 && error instanceof Error && needsAttention(error.message)) {
        throw new AttentionError(error.message);
      }
      throw error;
    }
  }

  private scheduleRetry(message: string): void {
    if (this.stopped || !machineEnabled(this.machine)) return;
    const healthyFor = this.connectedAt ? Date.now() - this.connectedAt : 0;
    this.connectedAt = 0;
    this.delay = nextReconnectDelay(this.delay, healthyFor);
    this.status = "reconnecting";
    this.error = message;
    this.options.changed();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.wanted()) {
        this.status = "idle";
        this.options.changed();
        return;
      }
      void this.connect();
    }, this.delay);
    this.retryTimer.unref?.();
  }

  private onEvent(event: EventFrame): void {
    if (event.event !== "state.changed" && event.event !== "agent.status.changed") return;
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshState().catch(() => {});
    }, 150);
    this.refreshTimer.unref?.();
  }

  private async refreshState(): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    const state = await connection.request({ type: "state.get" }, 15_000) as StateView;
    if (typeof state?.serverPid !== "number" || !Array.isArray(state.panes)) {
      throw new Error("remote Shepherd returned invalid state");
    }
    this.remoteState = state;
    this.checkedAt = new Date().toISOString();
    this.options.changed();
  }

  private startHealth(): void {
    this.stopHealth();
    this.healthTimer = setInterval(() => {
      const connection = this.connection;
      if (!connection) return;
      connection.request({ type: "ping" }, HEALTH_TIMEOUT_MS).catch(() => {
        if (this.connection === connection) connection.drop();
      });
    }, HEALTH_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  private stopHealth(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  private wanted(): boolean {
    return this.demanded || Date.now() - this.lastUsed < IDLE_CLOSE_MS;
  }

  /** Closes the bridge once nothing has wanted it for IDLE_CLOSE_MS. */
  private scheduleIdleCheck(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.demanded || this.stopped) return;
    const wait = Math.max(1_000, IDLE_CLOSE_MS - (Date.now() - this.lastUsed));
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.wanted()) {
        this.scheduleIdleCheck();
        return;
      }
      if (this.connection || this.retryTimer) {
        this.disconnect("idle");
        this.options.changed();
      }
    }, wait);
    this.idleTimer.unref?.();
  }

  private disconnect(status: MachineStatus): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopHealth();
    this.status = status;
    if (status === "disabled" || status === "idle") this.error = null;
    const connection = this.connection;
    this.connection = null;
    connection?.close();
    this.settleWaiters();
  }
}

/** Owns one link per saved machine and keeps them in step with
 * machines.json. */
export class MachineManager {
  private readonly links = new Map<string, MachineLink>();
  private demanded = false;

  constructor(private readonly options: MachineLinkOptions) {}

  sync(file: SavedMachineFile): void {
    const seen = new Set<string>();
    for (const machine of file.machines) {
      seen.add(machine.id);
      const existing = this.links.get(machine.id);
      if (existing) {
        existing.update(machine);
        continue;
      }
      const link = new MachineLink(machine, this.options);
      this.links.set(machine.id, link);
      if (this.demanded) link.setDemand(true);
    }
    for (const [id, link] of this.links) {
      if (seen.has(id)) continue;
      link.stop();
      this.links.delete(id);
    }
    this.options.changed();
  }

  setDemand(demanded: boolean): void {
    if (this.demanded === demanded) return;
    this.demanded = demanded;
    for (const link of this.links.values()) link.setDemand(demanded);
  }

  link(file: SavedMachineFile, labelOrId: string): MachineLink {
    const machine = findMachine(file, labelOrId);
    const link = this.links.get(machine.id);
    if (!link) throw new Error(`unknown machine: ${labelOrId}`);
    return link;
  }

  views(): RemoteMachineView[] {
    return [...this.links.values()].map((link) => link.view());
  }

  stop(): void {
    for (const link of this.links.values()) link.stop();
    this.links.clear();
  }
}

export function summarizeRemoteState(state: StateView): NonNullable<RemoteMachineView["remote"]> {
  const panes = state.panes.map((pane) => ({
    paneId: pane.id,
    title: pane.title,
    agent: pane.agent,
    status: pane.status,
    cwd: pane.cwd,
    updatedAt: pane.updatedAt,
    signal: pane.signal,
    task: pane.task,
    continuity: pane.continuity,
  }));
  return {
    serverPid: state.serverPid,
    protocolVersion: state.protocolVersion,
    workspaces: state.workspaces.length,
    tabs: state.workspaces.reduce((total, workspace) => total + workspace.tabs.length, 0),
    paneCount: state.panes.length,
    panes,
    agents: state.panes
      .filter((pane) => pane.agent)
      .map((pane) => ({
        paneId: pane.id,
        agent: pane.agent ?? "agent",
        status: pane.status,
        title: pane.title,
      })),
    workspaceList: state.workspaces,
    activeWorkspaceId: state.activeWorkspaceId,
  };
}

/** Resolves a pane ID or a unique agent name, like `shepherd agent get`. */
export function resolveRemotePane(state: StateView, target: string): PaneView {
  const byId = state.panes.find((pane) => pane.id === target);
  if (byId) return byId;
  const byAgent = state.panes.filter((pane) => pane.agent === target);
  if (byAgent.length === 1 && byAgent[0]) return byAgent[0];
  if (byAgent.length > 1) throw new Error(`multiple agents named ${target}; use a pane ID`);
  throw new Error(`unknown agent or pane: ${target}`);
}

export function renderLines(lines: TerminalLine[]): string {
  return lines.map((line) => line.map((span) => span.text).join("")).join("\n");
}

/** The machine.* operations, as requests over a link. Results match what
 * the equivalent remote CLI command prints. */
export async function remotePaneRead(
  link: MachineLink,
  paneId: string,
  rows: number,
  source: ReadSource,
): Promise<string> {
  const snapshot = await link.request({ type: "pane.snapshot", paneId, rows, source }, 20_000) as {
    lines: TerminalLine[];
  };
  return renderLines(snapshot.lines ?? []).trim();
}

export async function remoteAgentGet(link: MachineLink, target: string): Promise<string> {
  const state = await link.request({ type: "state.get" }, 15_000) as StateView;
  return JSON.stringify(resolveRemotePane(state, target), null, 2);
}

export async function remoteAgentRead(
  link: MachineLink,
  target: string,
  rows: number,
  source: ReadSource,
): Promise<string> {
  const state = await link.request({ type: "state.get" }, 15_000) as StateView;
  const pane = resolveRemotePane(state, target);
  return remotePaneRead(link, pane.id, rows, source);
}

export async function remoteAgentPrompt(
  link: MachineLink,
  target: string,
  prompt: string,
  timeoutMs: number,
): Promise<{ value: string; timedOut: boolean }> {
  const state = await link.request({ type: "state.get" }, 15_000) as StateView;
  const pane = resolveRemotePane(state, target);
  await link.request({ type: "agent.send", paneId: pane.id, text: prompt }, 15_000);
  const startWait = Math.min(5_000, timeoutMs);
  const activity = await link.request({
    type: "pane.wait",
    paneId: pane.id,
    statuses: ["working", "blocked"],
    timeoutMs: startWait,
  }, startWait + 10_000) as { status: string; timedOut: boolean };
  let settled = activity;
  if (activity.status === "working" && !activity.timedOut) {
    settled = await link.request({
      type: "pane.wait",
      paneId: pane.id,
      statuses: ["idle", "blocked", "done"],
      timeoutMs,
    }, timeoutMs + 10_000) as { status: string; timedOut: boolean };
  }
  return {
    value: JSON.stringify({ paneId: pane.id, prompt, ...settled }, null, 2),
    timedOut: settled.timedOut,
  };
}

export function operationResult(
  link: MachineLink,
  paneId: string,
  kind: RemoteAgentOperationResult["kind"],
  value: string,
  exitCode = 0,
): RemoteAgentOperationResult {
  return {
    machineId: link.machine.id,
    machineLabel: link.machine.label,
    paneId,
    kind,
    value,
    exitCode,
  };
}
