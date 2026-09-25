/** Agent integrations: hooks installed into an agent's own config that
 * report to Shepherd from inside a pane. The Claude Code integration
 * reports session, task and lifecycle observations. Muse uses managed hooks
 * because ordinary Muse hooks do not inherit Shepherd's environment.
 * No hook makes permission decisions. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configPath } from "../config/model.js";

export const INTEGRATION_VERSION = 3;
const MARKER = "shepherd-agent-state";
const CLAUDE_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Notification", "Stop", "StopFailure", "SessionEnd"];
const MUSE_EVENTS = [...CLAUDE_EVENTS, "PreLLMCall", "PostLLMCall", "PreCompact", "PostCompact"];
const MUSE_ENV = ["SHEPHERD_ENV", "SHEPHERD_SOCKET_PATH", "SHEPHERD_PANE_ID"];

export type IntegrationState = "not_installed" | "current" | "outdated";

export interface IntegrationInfo {
  target: string;
  label: string;
  command: string;
  available: boolean;
  state: IntegrationState;
}

interface Target {
  label: string;
  command: string;
  install(): string[];
  uninstall(): string[];
  state(): IntegrationState;
}

function integrationDirectory(target: string): string {
  return path.join(path.dirname(configPath()), "integrations", target);
}

function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(base, "settings.json");
}

/** The hook: reads the agent's hook JSON on stdin and reports the session to
 * the daemon over its socket. Silent and harmless outside Shepherd. */
function agentHookScript(agent: "claude" | "muse"): string {
  return `#!/usr/bin/env node
// ${MARKER} ${INTEGRATION_VERSION}: installed by shepherd; reinstalling overwrites this file.
import net from "node:net";

const socketPath = process.env.SHEPHERD_SOCKET_PATH;
const paneId = process.env.SHEPHERD_PANE_ID;
if (process.env.SHEPHERD_ENV !== "1" || !socketPath || !paneId) process.exit(0);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; if (input.length > 1024 * 1024) process.exit(0); });
process.stdin.on("end", () => {
  let hook = {};
  try { hook = JSON.parse(input || "{}"); } catch { process.exit(0); }
  if (!hook || typeof hook !== "object" || Array.isArray(hook) || hook.agent_id) process.exit(0);
  const event = hook.hook_event_name;
  const agent = ${JSON.stringify(agent)};
  const source = "shepherd:" + agent;
  const requests = [];
  const text = (value, max) => typeof value === "string" ? value.slice(0, max) : "";
  const status = (state) => requests.push({ type: "pane.report_agent", paneId, source, agent, state, ttlMs: 120000 });
  const task = (patch) => requests.push({ type: "task.update", paneId, source, patch });
  if (event === "SessionStart" && hook.session_id) {
    // Muse's memory-only sessions cannot be resumed.
    if (agent !== "muse" || hook.transcript_path) {
      requests.push({ type: "pane.report_agent_session", paneId, source, agent, sessionId: String(hook.session_id) });
    } else {
      requests.push({ type: "pane.release_agent", paneId, source });
    }
    if (agent === "muse") status(hook.source === "compact" ? "working" : "idle");
  } else if (event === "UserPromptSubmit") {
    status("working");
    task({ title: text(hook.prompt, 160), summary: "", nextAction: "", blocker: "", checkStatus: "unknown", checkSummary: "", review: "none" });
  } else if (agent === "muse" && event === "PreToolUse" && hook.tool_name === "request_user_input") {
    status("blocked");
    task({ blocker: "Muse is asking for input", nextAction: "Open the terminal to answer the question" });
  } else if (["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(event) || (agent === "muse" && ["PreLLMCall", "PostLLMCall", "PreCompact", "PostCompact"].includes(event))) {
    status("working");
    if (event !== "PreToolUse") task({ blocker: "" });
  } else if (event === "PermissionRequest" || (event === "Notification" && hook.notification_type === "permission_prompt")) {
    status("blocked");
    task({ blocker: text(hook.message, 1000) || "Permission requested for " + text(hook.tool_name || "an action", 160), nextAction: "Open the terminal to inspect the request and respond" });
  } else if (event === "Stop") {
    const background = Array.isArray(hook.background_tasks) ? hook.background_tasks.length : 0;
    status(background ? "working" : "idle");
    task({ summary: text(hook.last_assistant_message, 2000), blocker: "", review: "requested", nextAction: background ? "Review the response; " + background + " background tasks remain" : "Review the response and check results" });
  } else if (event === "StopFailure") {
    status("blocked");
    task({ blocker: text(hook.error_details || hook.error || "Agent request failed", 1000), nextAction: "Inspect the error and decide how to retry" });
  } else if (event === "Notification" && hook.notification_type === "idle_prompt") {
    status("idle");
  } else if (event === "SessionEnd") {
    requests.push({ type: "pane.release_agent", paneId, source });
    task({ review: "requested" });
  }
  if (!requests.length) process.exit(0);
  const socket = net.connect(socketPath);
  const done = () => { socket.destroy(); process.exit(0); };
  socket.setTimeout(1500, done);
  socket.on("error", done);
  let index = 0, buffer = "";
  const send = () => socket.write(JSON.stringify({ ...requests[index], id: String(index) }) + "\\n");
  socket.on("connect", send);
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let reply; try { reply = JSON.parse(line); } catch { continue; }
      if (reply.id !== String(index)) continue;
      if (!reply.ok || ++index >= requests.length) return done();
      send();
    }
  });
});
`;
}

function readJson(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8");
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function writeJson(file: string, value: unknown): void {
  // Config files are commonly symlinked into a dotfiles checkout. Keep the
  // link and the existing access mode when replacing their contents.
  if (fs.existsSync(file)) file = fs.realpathSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temporary, file);
}

type HookGroup = { matcher?: string; hooks?: Array<{ type?: string; command?: string }> };

function withoutOurHooks(groups: unknown): HookGroup[] {
  if (!Array.isArray(groups)) return [];
  return (groups as HookGroup[])
    .map((group) => ({
      ...group,
      hooks: (group.hooks ?? []).filter((hook) => !String(hook.command ?? "").includes(MARKER)),
    }))
    .filter((group) => (group.hooks ?? []).length > 0);
}

const claude: Target = {
  label: "Claude Code",
  command: "claude",
  install() {
    const directory = integrationDirectory("claude");
    fs.mkdirSync(directory, { recursive: true });
    const script = path.join(directory, `${MARKER}.mjs`);
    fs.writeFileSync(script, agentHookScript("claude"), { mode: 0o755 });
    const settingsFile = claudeSettingsPath();
    const settings = readJson(settingsFile);
    const hooks = (settings.hooks && typeof settings.hooks === "object"
      ? settings.hooks
      : {}) as Record<string, unknown>;
    const quotedScript = process.platform === "win32" ? JSON.stringify(script) : `'${script.replace(/'/g, `'\\''`)}'`;
    for (const event of CLAUDE_EVENTS) {
      hooks[event] = [
        ...withoutOurHooks(hooks[event]),
        { hooks: [{ type: "command", command: `node ${quotedScript}`, timeout: 3 }] },
      ];
    }
    settings.hooks = hooks;
    writeJson(settingsFile, settings);
    return [`installed hook script ${script}`, `added session, task and status hooks to ${settingsFile}`];
  },
  uninstall() {
    const messages: string[] = [];
    const settingsFile = claudeSettingsPath();
    if (fs.existsSync(settingsFile)) {
      const settings = readJson(settingsFile);
      const hooks = settings.hooks as Record<string, unknown> | undefined;
      if (hooks) {
        for (const event of CLAUDE_EVENTS) {
          const remaining = withoutOurHooks(hooks[event]);
          if (remaining.length > 0) hooks[event] = remaining;
          else delete hooks[event];
        }
        writeJson(settingsFile, settings);
        messages.push(`removed Shepherd hooks from ${settingsFile}`);
      }
    }
    fs.rmSync(integrationDirectory("claude"), { recursive: true, force: true });
    messages.push("removed hook script");
    return messages;
  },
  state() {
    try {
      const hooks = readJson(claudeSettingsPath()).hooks as Record<string, unknown> | undefined;
      const installed = JSON.stringify(hooks?.SessionStart ?? []).includes(MARKER);
      if (!installed) return "not_installed";
      if (!CLAUDE_EVENTS.every(event => JSON.stringify(hooks?.[event] ?? []).includes(MARKER))) return "outdated";
      const script = path.join(integrationDirectory("claude"), `${MARKER}.mjs`);
      if (!fs.existsSync(script)) return "outdated";
      return fs.readFileSync(script, "utf8").includes(`${MARKER} ${INTEGRATION_VERSION}:`)
        ? "current"
        : "outdated";
    } catch {
      return "not_installed";
    }
  },
};

function museSettingsPath(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "muse", "settings.json");
}

function museManagedPath(settings: Record<string, unknown>): string {
  const configured = settings.managed_hooks_path;
  if (configured !== undefined && (typeof configured !== "string" || !configured.trim())) {
    throw new Error("Muse managed_hooks_path must be a non-empty path");
  }
  return configured
    ? path.resolve(path.dirname(museSettingsPath()), configured as string)
    : path.join(integrationDirectory("muse"), "hooks.json");
}

function hookMap(document: Record<string, unknown>): Record<string, unknown> {
  const hooks = document.hooks;
  if (hooks === undefined) return {};
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error("Muse hooks must be an object; existing configuration was left unchanged");
  }
  // Muse also has a stricter managed schema. Mixing the two schemas silently
  // disables events, so leave that configuration intact and explain the issue.
  for (const [event, groups] of Object.entries(hooks)) {
    if (event === "state") continue;
    if (!Array.isArray(groups) || groups.some(group => !group || typeof group !== "object"
      || !Array.isArray(group.hooks) || group.hooks.some((handler: unknown) => !handler
        || typeof handler !== "object" || "name" in handler || "timeout_ms" in handler))) {
      throw new Error("Muse managed hooks must use matcher groups with command handlers (not the strict name/timeout_ms schema); existing configuration was left unchanged");
    }
  }
  return hooks as Record<string, unknown>;
}

/** Muse 1.4: https://meta-models.github.io/muse-code-sdk/next/guides/extend/hooks/ */
const muse: Target = {
  label: "Muse Code",
  command: "muse",
  install() {
    const settingsFile = museSettingsPath();
    const settings = readJson(settingsFile);
    const managedFile = museManagedPath(settings);
    if (managedFile === path.resolve(settingsFile)) throw new Error("Muse settings and managed hooks must be different files");
    const managed = readJson(managedFile);
    const hooks = hookMap(managed);
    const env = settings.managed_hooks_env_vars ?? [];
    if (!Array.isArray(env) || env.some(value => typeof value !== "string")) {
      throw new Error("Muse managed_hooks_env_vars must be an array of variable names");
    }
    if (settings.schema_version !== undefined && settings.schema_version !== 1) {
      throw new Error("Unsupported Muse settings schema_version; expected 1");
    }
    const directory = integrationDirectory("muse");
    const script = path.join(directory, `${MARKER}.mjs`);
    const quote = (value: string) => process.platform === "win32" ? JSON.stringify(value) : `'${value.replaceAll("'", "'\\''")}'`;
    // Use the running Node executable: Muse retains PATH, but a daemon may
    // have been launched from a different Node installation than the shell.
    const command = `${quote(process.execPath)} ${quote(script)}`;
    for (const event of MUSE_EVENTS) {
      hooks[event] = [...withoutOurHooks(hooks[event]), { hooks: [{ type: "command", command, timeout: 3 }] }];
    }
    const addedEnv = MUSE_ENV.filter(name => !env.some(value => value.toUpperCase() === name));
    const receiptFile = path.join(directory, "install.json");
    const receipt = readJson(receiptFile);
    // Keep the original ownership information across repeated installations.
    const previousAdded = receipt.managedFile === managedFile && Array.isArray(receipt.addedEnv) ? receipt.addedEnv : [];
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(script, agentHookScript("muse"), { mode: 0o755 });
    writeJson(receiptFile, { managedFile, addedEnv: [...new Set([...previousAdded, ...addedEnv])] });
    writeJson(managedFile, { ...managed, hooks });
    settings.schema_version = 1;
    settings.managed_hooks_path ??= managedFile;
    settings.managed_hooks_env_vars = [...env, ...addedEnv];
    writeJson(settingsFile, settings);
    return [`installed hook script ${script}`, `added session, task and status hooks to ${managedFile}`, `configured Shepherd environment forwarding in ${settingsFile}; start a new Muse session to load the hooks`];
  },
  uninstall() {
    const settingsFile = museSettingsPath();
    const settings = readJson(settingsFile);
    const directory = integrationDirectory("muse");
    const receipt = readJson(path.join(directory, "install.json"));
    const managedFile = typeof receipt.managedFile === "string" ? receipt.managedFile : museManagedPath(settings);
    const managed = readJson(managedFile);
    const hooks = hookMap(managed);
    for (const event of MUSE_EVENTS) {
      const remaining = withoutOurHooks(hooks[event]);
      if (remaining.length) hooks[event] = remaining;
      else delete hooks[event];
    }
    if (fs.existsSync(managedFile)) writeJson(managedFile, { ...managed, hooks });
    const ownFile = path.join(directory, "hooks.json");
    const keepManagedFile = managedFile === ownFile && Object.keys(hooks).length > 0;
    if (fs.existsSync(settingsFile) && museManagedPath(settings) === managedFile) {
      if (managedFile === ownFile && !keepManagedFile) delete settings.managed_hooks_path;
      if (Array.isArray(settings.managed_hooks_env_vars) && Array.isArray(receipt.addedEnv)) {
        const addedEnv = receipt.addedEnv;
        settings.managed_hooks_env_vars = settings.managed_hooks_env_vars.filter(name => !addedEnv.includes(name));
      }
      writeJson(settingsFile, settings);
    }
    // Remove only our artifacts. A user may have added hooks or other files
    // under this directory since installation.
    for (const file of [`${MARKER}.mjs`, "install.json"]) fs.rmSync(path.join(directory, file), { force: true });
    if (managedFile === ownFile && !keepManagedFile) fs.rmSync(ownFile, { force: true });
    try { fs.rmdirSync(directory); } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    return [`removed Shepherd hooks from ${managedFile}`, "removed hook script"];
  },
  state() {
    try {
      const settings = readJson(museSettingsPath());
      const hooks = hookMap(readJson(museManagedPath(settings)));
      if (!JSON.stringify(hooks).includes(MARKER)) return "not_installed";
      const env = settings.managed_hooks_env_vars;
      if (!Array.isArray(env) || !MUSE_ENV.every(name => env.includes(name))
        || !MUSE_EVENTS.every(event => JSON.stringify(hooks[event] ?? []).includes(MARKER))) return "outdated";
      const script = path.join(integrationDirectory("muse"), `${MARKER}.mjs`);
      return fs.existsSync(script) && fs.readFileSync(script, "utf8").includes(`${MARKER} ${INTEGRATION_VERSION}:`)
        ? "current" : "outdated";
    } catch {
      return "not_installed";
    }
  },
};

const TARGETS: Record<string, Target> = { claude, muse };

function onPath(command: string): boolean {
  return (process.env.PATH ?? "").split(path.delimiter).some((directory) => {
    try {
      fs.accessSync(path.join(directory, command), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function listIntegrations(): IntegrationInfo[] {
  return Object.entries(TARGETS).map(([target, spec]) => ({
    target,
    label: spec.label,
    command: spec.command,
    available: onPath(spec.command),
    state: spec.state(),
  }));
}

function requireTarget(target: string): Target {
  const spec = TARGETS[target];
  if (!spec) throw new Error(`unsupported integration target: ${target}`);
  return spec;
}

export function installIntegration(target: string): string[] {
  return requireTarget(target).install();
}

export function uninstallIntegration(target: string): string[] {
  return requireTarget(target).uninstall();
}
