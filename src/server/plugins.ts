import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { LIFECYCLE_EVENTS } from "./pluginLifecycle.js";

export type PluginPlatform = "linux" | "macos" | "windows";
export type PluginActionContext = "global" | "workspace" | "tab" | "pane" | "selection";
export type PluginPanePlacement = "overlay" | "popup" | "split" | "tab" | "zoomed";
/** Popup dimension: terminal cells, or a percentage string like "80%". */
export type PluginPaneSize = number | string;

export const PLUGIN_PLATFORMS: readonly PluginPlatform[] = ["linux", "macos", "windows"];
export const PLUGIN_ACTION_CONTEXTS: readonly PluginActionContext[] = [
  "global",
  "workspace",
  "tab",
  "pane",
  "selection",
];
export const PLUGIN_PANE_PLACEMENTS: readonly PluginPanePlacement[] = [
  "overlay",
  "popup",
  "split",
  "tab",
  "zoomed",
];

/** Event names a `[[events]]` hook may listen to: the lifecycle events
 * derived from session state plus Shepherd's own daemon events. */
export const DIRECT_HOOK_EVENTS: ReadonlySet<string> = new Set([
  "pane.bell",
  "pane.exited",
  "agent.status.changed",
  "notification.show",
  "popup.opened",
  "popup.closed",
  "marketplace.updated",
]);

export const PLUGIN_HOOK_EVENTS: ReadonlySet<string> = new Set([
  ...LIFECYCLE_EVENTS,
  ...DIRECT_HOOK_EVENTS,
]);

export interface PluginAction {
  id: string;
  title: string;
  command: string[];
  description?: string;
  contexts?: PluginActionContext[];
  platforms?: PluginPlatform[];
}

export interface PluginCommandEntry {
  command: string[];
  platforms?: PluginPlatform[];
}

export interface PluginEventHook extends PluginCommandEntry {
  on: string[];
}

export interface PluginPaneEntrypoint {
  id: string;
  title: string;
  description?: string;
  placement: PluginPanePlacement;
  width?: PluginPaneSize;
  height?: PluginPaneSize;
  command: string[];
  platforms?: PluginPlatform[];
}

export interface PluginLinkHandler {
  id: string;
  title: string;
  pattern: string;
  action: string;
  platforms?: PluginPlatform[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  minShepherdVersion?: string;
  platforms?: PluginPlatform[];
  root: string;
  manifestPath: string;
  actions: PluginAction[];
  builds: PluginCommandEntry[];
  startup: PluginCommandEntry[];
  events: PluginEventHook[];
  panes: PluginPaneEntrypoint[];
  linkHandlers: PluginLinkHandler[];
  /** Non-fatal manifest problems, such as unknown event names. */
  warnings: string[];
}

export interface PersistedPlugin {
  manifestPath: string;
  enabled: boolean;
}

type Raw = Record<string, unknown>;

export const SHEPHERD_VERSION = (() => {
  try {
    const url = new URL("../../package.json", import.meta.url);
    const parsed = JSON.parse(fs.readFileSync(url, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export function currentPlatform(): PluginPlatform {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

/** Item platforms override the plugin's; no list means every platform. */
export function supportsPlatform(
  itemPlatforms: PluginPlatform[] | undefined,
  pluginPlatforms: PluginPlatform[] | undefined,
  platform: PluginPlatform = currentPlatform(),
): boolean {
  const effective = itemPlatforms ?? pluginPlatforms;
  return !effective || effective.includes(platform);
}

/** Compares dotted numeric versions; pre-release suffixes are ignored. */
export function compareVersions(left: string, right: string): number {
  const parts = (value: string) =>
    value.trim().replace(/^v/i, "").split(/[-+]/)[0]!.split(".").map((part) => {
      const number = Number.parseInt(part, 10);
      return Number.isFinite(number) ? number : 0;
    });
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function loadPluginManifest(inputPath: string): PluginManifest {
  const resolved = path.resolve(inputPath);
  const manifestPath = fs.statSync(resolved).isFile()
    ? resolved
    : path.join(resolved, "shepherd-plugin.toml");
  return parsePluginManifest(
    fs.readFileSync(manifestPath, "utf8"),
    path.dirname(manifestPath),
    manifestPath,
  );
}

/** Rejects a manifest the running Shepherd cannot host: a newer
 * `min_shepherd_version` or a platform list without this platform. */
export function assertPluginCompatible(
  manifest: PluginManifest,
  version: string = SHEPHERD_VERSION,
  platform: PluginPlatform = currentPlatform(),
): void {
  if (
    manifest.minShepherdVersion &&
    compareVersions(manifest.minShepherdVersion, version) > 0
  ) {
    throw new Error(
      `plugin ${manifest.id} requires Shepherd ${manifest.minShepherdVersion} or newer (this is ${version})`,
    );
  }
  if (manifest.platforms && !manifest.platforms.includes(platform)) {
    throw new Error(
      `plugin ${manifest.id} does not support ${platform} (supports ${manifest.platforms.join(", ")})`,
    );
  }
}

export function parsePluginManifest(
  content: string,
  root: string,
  manifestPath: string,
): PluginManifest {
  const raw = parse(content) as Raw;
  const id = requiredString(raw.id, "plugin id");
  const name = requiredString(raw.name, "plugin name");
  const version = requiredString(raw.version, "plugin version");
  if (!/^[a-z][a-z0-9_.:-]{1,79}$/i.test(id)) {
    throw new Error(`invalid plugin id: ${id}`);
  }
  const warnings: string[] = [];
  const minShepherdVersion = optionalString(raw.min_shepherd_version) ?? undefined;
  if (minShepherdVersion !== undefined && !/^v?\d+(\.\d+)*([-+].*)?$/.test(minShepherdVersion)) {
    throw new Error(`invalid min_shepherd_version: ${minShepherdVersion}`);
  }
  const platforms = parsePlatforms(raw.platforms, "platforms");

  const rawActions = optionalArray(raw.actions, "actions");
  const actions = rawActions.map((entry, index): PluginAction => {
    const action = table(entry, `actions[${index}]`);
    const actionId = localId(action.id, `actions[${index}].id`, "plugin action");
    const command = argv(action.command, `plugin action ${actionId} command`);
    const result: PluginAction = {
      id: actionId,
      title: optionalString(action.title) ?? actionId,
      command,
    };
    const description = optionalString(action.description);
    if (description) result.description = description;
    if (action.contexts !== undefined) {
      result.contexts = enumList(
        action.contexts,
        PLUGIN_ACTION_CONTEXTS,
        `plugin action ${actionId} contexts`,
      );
    }
    const itemPlatforms = parsePlatforms(action.platforms, `actions[${index}].platforms`);
    if (itemPlatforms) result.platforms = itemPlatforms;
    return result;
  });
  unique(actions.map((action) => action.id), "plugin action IDs must be unique");

  const commandEntries = (value: unknown, label: string): PluginCommandEntry[] =>
    optionalArray(value, label).map((entry, index) => {
      const item = table(entry, `${label}[${index}]`);
      const result: PluginCommandEntry = {
        command: argv(item.command, `plugin ${label}[${index}].command`),
      };
      const itemPlatforms = parsePlatforms(item.platforms, `${label}[${index}].platforms`);
      if (itemPlatforms) result.platforms = itemPlatforms;
      return result;
    });
  const builds = commandEntries(raw.build, "build");
  const startup = commandEntries(raw.startup, "startup");

  const events = optionalArray(raw.events, "events").map((entry, index): PluginEventHook => {
    const hook = table(entry, `events[${index}]`);
    const on = typeof hook.on === "string"
      ? [hook.on]
      : Array.isArray(hook.on)
        ? hook.on.map((value, onIndex) => {
          if (typeof value !== "string" || !value.trim()) {
            throw new Error(`plugin events[${index}].on[${onIndex}] must be a string`);
          }
          return value.trim();
        })
        : [];
    if (on.length === 0) {
      throw new Error(`plugin events[${index}].on must name at least one event`);
    }
    for (const name of on) {
      if (!PLUGIN_HOOK_EVENTS.has(name)) {
        warnings.push(`events[${index}] listens to unknown event ${name}`);
      }
    }
    const result: PluginEventHook = {
      on,
      command: argv(hook.command, `plugin events[${index}].command`),
    };
    const itemPlatforms = parsePlatforms(hook.platforms, `events[${index}].platforms`);
    if (itemPlatforms) result.platforms = itemPlatforms;
    return result;
  });

  const panes = optionalArray(raw.panes, "panes").map((entry, index): PluginPaneEntrypoint => {
    const pane = table(entry, `panes[${index}]`);
    const paneId = localId(pane.id, `panes[${index}].id`, "plugin pane");
    const placement = pane.placement === undefined
      ? "overlay"
      : enumValue(pane.placement, PLUGIN_PANE_PLACEMENTS, `plugin pane ${paneId} placement`);
    const result: PluginPaneEntrypoint = {
      id: paneId,
      title: optionalString(pane.title) ?? paneId,
      placement,
      command: argv(pane.command, `plugin pane ${paneId} command`),
    };
    const description = optionalString(pane.description);
    if (description) result.description = description;
    const width = paneSize(pane.width, `plugin pane ${paneId} width`);
    if (width !== undefined) result.width = width;
    const height = paneSize(pane.height, `plugin pane ${paneId} height`);
    if (height !== undefined) result.height = height;
    const itemPlatforms = parsePlatforms(pane.platforms, `panes[${index}].platforms`);
    if (itemPlatforms) result.platforms = itemPlatforms;
    return result;
  });
  unique(panes.map((pane) => pane.id), "plugin pane IDs must be unique");

  const linkHandlers = optionalArray(raw.link_handlers, "link_handlers").map(
    (entry, index): PluginLinkHandler => {
      const handler = table(entry, `link_handlers[${index}]`);
      const handlerId = localId(handler.id, `link_handlers[${index}].id`, "plugin link handler");
      const pattern = requiredString(handler.pattern, `link handler ${handlerId} pattern`);
      try {
        new RegExp(pattern);
      } catch (error) {
        throw new Error(
          `plugin link handler ${handlerId} pattern is not a valid regular expression: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const action = requiredString(handler.action, `link handler ${handlerId} action`);
      if (!actions.some((entry) => entry.id === action)) {
        throw new Error(`plugin link handler ${handlerId} names unknown action ${action}`);
      }
      const result: PluginLinkHandler = {
        id: handlerId,
        title: optionalString(handler.title) ?? handlerId,
        pattern,
        action,
      };
      const itemPlatforms = parsePlatforms(handler.platforms, `link_handlers[${index}].platforms`);
      if (itemPlatforms) result.platforms = itemPlatforms;
      return result;
    },
  );
  unique(linkHandlers.map((handler) => handler.id), "plugin link handler IDs must be unique");

  if (
    actions.length + startup.length + events.length + panes.length === 0
  ) {
    throw new Error("plugin declares no actions, startup hooks, event hooks, or panes");
  }

  const manifest: PluginManifest = {
    id,
    name,
    version,
    root,
    manifestPath,
    actions,
    builds,
    startup,
    events,
    panes,
    linkHandlers,
    warnings,
  };
  const description = optionalString(raw.description);
  if (description) manifest.description = description;
  if (minShepherdVersion) manifest.minShepherdVersion = minShepherdVersion;
  if (platforms) manifest.platforms = platforms;
  return manifest;
}

export async function runPluginBuilds(
  manifest: PluginManifest,
): Promise<Array<{ command: string[]; exitCode: number | null }>> {
  const results: Array<{ command: string[]; exitCode: number | null }> = [];
  for (const build of manifest.builds) {
    if (!supportsPlatform(build.platforms, manifest.platforms)) continue;
    const [command, ...args] = build.command;
    if (!command) continue;
    const result = await new Promise<{ exitCode: number | null }>((resolve) => {
      const child = spawn(command, args, {
        cwd: manifest.root,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk);
      });
      child.on("error", () => resolve({ exitCode: null }));
      child.on("close", (exitCode) => resolve({ exitCode }));
    });
    results.push({ command: build.command, exitCode: result.exitCode });
    if (result.exitCode !== 0) {
      throw new Error(
        `plugin build failed with exit code ${result.exitCode ?? "unknown"}: ${build.command.join(" ")}`,
      );
    }
  }
  return results;
}

export function pluginRegistryPath(stateDirectory: string): string {
  return path.join(stateDirectory, "plugins.json");
}

export function loadPluginRegistry(
  stateDirectory: string,
): PersistedPlugin[] {
  try {
    const value = JSON.parse(
      fs.readFileSync(pluginRegistryPath(stateDirectory), "utf8"),
    ) as PersistedPlugin[];
    return Array.isArray(value) ? value.filter(isPersistedPlugin) : [];
  } catch {
    return [];
  }
}

export function savePluginRegistry(
  stateDirectory: string,
  plugins: PersistedPlugin[],
): void {
  const target = pluginRegistryPath(stateDirectory);
  fs.mkdirSync(stateDirectory, { recursive: true });
  const temporary = `${target}.tmp`;
  fs.writeFileSync(
    temporary,
    `${JSON.stringify(plugins, null, 2)}\n`,
    "utf8",
  );
  fs.renameSync(temporary, target);
}

/** User-editable configuration for one plugin (credentials, `.env`
 * files). Shared by every session; `SHEPHERD_CONFIG_HOME` overrides the
 * base like it does for config.toml. */
export function pluginConfigDirectory(
  pluginId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = env.SHEPHERD_CONFIG_HOME
    ? path.resolve(env.SHEPHERD_CONFIG_HOME)
    : path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "shepherd");
  return path.join(base, "plugins", pluginDirectoryName(pluginId));
}

/** Runtime state a plugin keeps for one session. */
export function pluginStateDirectory(sessionStateDirectory: string, pluginId: string): string {
  return path.join(sessionStateDirectory, "plugin-state", pluginDirectoryName(pluginId));
}

function pluginDirectoryName(pluginId: string): string {
  if (!/^[a-z][a-z0-9_.:-]{1,79}$/i.test(pluginId)) {
    throw new Error(`invalid plugin id: ${pluginId}`);
  }
  return pluginId.replaceAll(":", "_");
}

export interface PluginInvocationContext {
  invocation_source: string;
  workspace_id?: string;
  workspace_label?: string;
  workspace_cwd?: string;
  tab_id?: string;
  tab_label?: string;
  focused_pane_id?: string;
  focused_pane_cwd?: string;
  focused_pane_agent?: string;
  focused_pane_status?: string;
  clicked_url?: string;
  link_handler_id?: string;
  event?: string;
  [key: string]: unknown;
}

export interface PluginRuntime {
  socketPath: string;
  binPath: string;
  configDirectory: string;
  stateDirectory: string;
}

/** Environment every plugin process (action, startup, event, pane) gets. */
export function pluginEnvironment(
  manifest: PluginManifest,
  runtime: PluginRuntime,
  context: PluginInvocationContext,
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string | undefined> = {
    SHEPHERD_ENV: "1",
    SHEPHERD_PLUGIN_ID: manifest.id,
    SHEPHERD_PLUGIN_ROOT: manifest.root,
    SHEPHERD_PLUGIN_CONFIG_DIR: runtime.configDirectory,
    SHEPHERD_PLUGIN_STATE_DIR: runtime.stateDirectory,
    SHEPHERD_SOCKET_PATH: runtime.socketPath,
    SHEPHERD_BIN_PATH: runtime.binPath,
    SHEPHERD_PLUGIN_CONTEXT_JSON: JSON.stringify(context),
    SHEPHERD_ACTIVE_WORKSPACE_ID: context.workspace_id,
    SHEPHERD_ACTIVE_TAB_ID: context.tab_id,
    SHEPHERD_ACTIVE_PANE_ID: context.focused_pane_id,
    SHEPHERD_PLUGIN_CLICKED_URL: context.clicked_url,
    SHEPHERD_PLUGIN_LINK_HANDLER_ID: context.link_handler_id,
    ...extra,
  };
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function ensurePluginDirectories(runtime: PluginRuntime): void {
  fs.mkdirSync(runtime.configDirectory, { recursive: true });
  fs.mkdirSync(runtime.stateDirectory, { recursive: true });
}

export interface PluginCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: string | null;
}

/** Runs an argv command in the plugin root (never through a shell),
 * capturing capped stdout/stderr. */
export function runPluginCommand(
  root: string,
  argvCommand: string[],
  env: Record<string, string>,
  options: { stdin?: string; timeoutMs?: number } = {},
): Promise<PluginCommandResult> {
  const [command, ...args] = argvCommand;
  if (!command) {
    return Promise.resolve({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      error: "command must not be empty",
    });
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: PluginCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs ?? 30_000);

    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin);
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      finish({
        exitCode: null,
        stdout,
        stderr,
        timedOut,
        error: error.message,
      });
    });
    child.on("close", (exitCode) => {
      finish({
        exitCode,
        stdout,
        stderr,
        timedOut,
        error: timedOut ? "timed out" : null,
      });
    });
  });
}

/** A shell command line that runs `argv` verbatim (for pane commands,
 * which the pane starts through the user's shell). */
export function shellCommandLine(argvCommand: string[]): string {
  return argvCommand
    .map((value) => /^[A-Za-z0-9_\-./=:@%+,]+$/.test(value)
      ? value
      : `'${value.replaceAll("'", "'\\''")}'`)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Command log

export type PluginCommandKind = "action" | "startup" | "event" | "pane";
export type PluginCommandStatus = "running" | "succeeded" | "failed";

export interface PluginCommandLog {
  logId: string;
  pluginId: string;
  kind: PluginCommandKind;
  actionId?: string;
  event?: string;
  entrypointId?: string;
  command: string[];
  status: PluginCommandStatus;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

/** Output kept per log entry (the tail). */
export const PLUGIN_LOG_OUTPUT_TAIL = 8_000;
/** Entries kept per plugin, oldest dropped first. */
export const PLUGIN_LOG_LIMIT_PER_PLUGIN = 100;

/** Recent plugin command runs, bounded per plugin. */
export class PluginLogStore {
  private readonly logs = new Map<string, PluginCommandLog[]>();
  private nextId = 1;

  constructor(private readonly limitPerPlugin = PLUGIN_LOG_LIMIT_PER_PLUGIN) {}

  start(entry: Omit<PluginCommandLog, "logId" | "status" | "startedAt" | "finishedAt" | "exitCode" | "stdout" | "stderr" | "error">): PluginCommandLog {
    const log: PluginCommandLog = {
      logId: `plugin-log-${this.nextId}`,
      ...entry,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: null,
    };
    this.nextId += 1;
    const list = this.logs.get(entry.pluginId) ?? [];
    list.push(log);
    if (list.length > this.limitPerPlugin) list.splice(0, list.length - this.limitPerPlugin);
    this.logs.set(entry.pluginId, list);
    return log;
  }

  finish(log: PluginCommandLog, result: PluginCommandResult): PluginCommandLog {
    log.finishedAt = Date.now();
    log.exitCode = result.exitCode;
    log.stdout = tail(result.stdout);
    log.stderr = tail(result.stderr);
    log.error = result.error;
    log.status = result.exitCode === 0 && !result.timedOut && !result.error
      ? "succeeded"
      : "failed";
    return log;
  }

  /** Newest last, like a log file; `limit` keeps the newest entries. */
  list(pluginId?: string, limit?: number): PluginCommandLog[] {
    const entries = pluginId === undefined
      ? [...this.logs.values()].flat().sort((a, b) =>
        a.startedAt - b.startedAt || logNumber(a) - logNumber(b)
      )
      : [...(this.logs.get(pluginId) ?? [])];
    const kept = limit !== undefined && limit >= 0 ? entries.slice(Math.max(0, entries.length - limit)) : entries;
    return kept.map((entry) => ({ ...entry, command: [...entry.command] }));
  }

  forget(pluginId: string): void {
    this.logs.delete(pluginId);
  }
}

function logNumber(log: PluginCommandLog): number {
  return Number.parseInt(log.logId.slice("plugin-log-".length), 10) || 0;
}

function tail(value: string): string {
  return value.length > PLUGIN_LOG_OUTPUT_TAIL
    ? value.slice(value.length - PLUGIN_LOG_OUTPUT_TAIL)
    : value;
}

// ---------------------------------------------------------------------------
// Link handlers

/** The first enabled link handler (plugins in order, handlers in manifest
 * order) whose pattern matches `url`. */
export function matchLinkHandler(
  plugins: Iterable<{ manifest: PluginManifest; enabled: boolean }>,
  url: string,
): { manifest: PluginManifest; handler: PluginLinkHandler } | null {
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    for (const handler of plugin.manifest.linkHandlers) {
      if (!supportsPlatform(handler.platforms, plugin.manifest.platforms)) continue;
      let pattern: RegExp;
      try {
        pattern = new RegExp(handler.pattern);
      } catch {
        continue;
      }
      if (pattern.test(url)) return { manifest: plugin.manifest, handler };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parsing helpers

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function optionalArray(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`plugin ${label} must be an array`);
  return value;
}

function table(value: unknown, label: string): Raw {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`plugin ${label} must be a table`);
  }
  return value as Raw;
}

function localId(value: unknown, label: string, kind: string): string {
  const id = requiredString(value, label);
  if (!/^[a-z0-9][a-z0-9:_-]{0,63}$/i.test(id)) {
    throw new Error(`invalid ${kind} id: ${id}`);
  }
  return id;
}

function argv(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty argv array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`${label}[${index}] must be a string`);
    }
    return entry;
  });
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function enumList<T extends string>(value: unknown, allowed: readonly T[], label: string): T[] {
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list)) throw new Error(`${label} must be an array`);
  return [...new Set(list.map((entry) => enumValue(entry, allowed, label)))];
}

function parsePlatforms(value: unknown, label: string): PluginPlatform[] | undefined {
  if (value === undefined) return undefined;
  const list = enumList(value, PLUGIN_PLATFORMS, `plugin ${label}`);
  if (list.length === 0) throw new Error(`plugin ${label} must not be empty`);
  return list;
}

function paneSize(value: unknown, label: string): PluginPaneSize | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^(\d{1,3})%$/.test(value.trim())) {
    const percent = Number.parseInt(value, 10);
    if (percent > 0 && percent <= 100) return value.trim();
  }
  throw new Error(`${label} must be a positive cell count or a percentage like "80%"`);
}

function unique(values: string[], message: string): void {
  if (new Set(values).size !== values.length) throw new Error(message);
}

function appendCapped(current: string, addition: string): string {
  const next = `${current}${addition}`;
  return next.length > 64_000
    ? next.slice(next.length - 64_000)
    : next;
}

function isPersistedPlugin(value: unknown): value is PersistedPlugin {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<PersistedPlugin>;
  return typeof entry.manifestPath === "string" &&
    typeof entry.enabled === "boolean";
}
