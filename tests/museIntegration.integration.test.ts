import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installIntegration, listIntegrations, uninstallIntegration } from "../src/server/integrations.js";
import { ClientConnection } from "../src/client/connection.js";
import { ShepherdDaemon } from "../src/server/daemon.js";
import { loadState } from "../src/server/persistence.js";
import { shellCommand } from "../src/server/agentSessions.js";
import { processTable } from "../src/server/processes.js";
import { connect } from "../src/transport.js";
import type { StateView } from "../src/types.js";

let root: string;
let settingsFile: string;
let integrationDir: string;
let daemon: ShepherdDaemon | undefined;
let connection: ClientConnection | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-muse-")));
  vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "config"));
  vi.stubEnv("XDG_DATA_HOME", path.join(root, "data"));
  vi.stubEnv("XDG_STATE_HOME", path.join(root, "state"));
  vi.stubEnv("XDG_CACHE_HOME", path.join(root, "cache"));
  vi.stubEnv("MUSE_NO_AUTO_UPDATE", "1");
  vi.stubEnv("SHEPHERD_CONFIG_PATH", path.join(root, "shepherd", "config.toml"));
  vi.stubEnv("SHEPHERD_STATE_HOME", path.join(root, "shepherd-state"));
  settingsFile = path.join(root, "config", "muse", "settings.json");
  integrationDir = path.join(root, "shepherd", "integrations", "muse");
});

afterEach(async () => {
  connection?.close();
  await daemon?.stop();
  connection = undefined;
  daemon = undefined;
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function readJson(file: string) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function integrationState() { return listIntegrations().find(entry => entry.target === "muse")?.state; }

function run(file: string, args: string[], env: NodeJS.ProcessEnv, input = "") {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`process timed out: ${stderr}`)); }, 15_000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

async function startDaemon() {
  daemon = new ShepherdDaemon({ session: "muse", socketPath: path.join(root, "daemon.sock") });
  await daemon.start();
  connection = ClientConnection.open(await connect(path.join(root, "daemon.sock")));
}

describe("Muse managed hook installation", () => {
  it("creates valid settings, installs idempotently, detects outdated hooks, and uninstalls", () => {
    expect(integrationState()).toBe("not_installed");
    installIntegration("muse");
    installIntegration("muse");
    const settings = readJson(settingsFile);
    expect(settings).toMatchObject({ schema_version: 1, managed_hooks_env_vars: ["SHEPHERD_ENV", "SHEPHERD_SOCKET_PATH", "SHEPHERD_PANE_ID"] });
    expect(readJson(settings.managed_hooks_path).hooks.SessionStart).toHaveLength(1);
    expect(integrationState()).toBe("current");
    fs.writeFileSync(path.join(integrationDir, "shepherd-agent-state.mjs"), "// older hook");
    expect(integrationState()).toBe("outdated");
    installIntegration("muse");
    settings.managed_hooks_env_vars.pop();
    writeJson(settingsFile, settings);
    expect(integrationState()).toBe("outdated");
    installIntegration("muse");
    expect(integrationState()).toBe("current");
    uninstallIntegration("muse");
    expect(integrationState()).toBe("not_installed");
    expect(readJson(settingsFile).managed_hooks_path).toBeUndefined();
    expect(readJson(settingsFile).managed_hooks_env_vars).toEqual([]);
    expect(fs.existsSync(integrationDir)).toBe(false);
  });

  it("preserves user settings, relative managed paths, hooks, and preexisting environment forwarding", () => {
    const original = {
      schema_version: 1, model: "my-model", managed_hooks_path: "team-hooks.json",
      managed_hooks_env_vars: ["TEAM_FLAG", "SHEPHERD_ENV"],
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo my-user-hook" }] }] },
    };
    const managedFile = path.join(path.dirname(settingsFile), "team-hooks.json");
    const managed = { hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo my-managed-hook" }] }] } };
    writeJson(settingsFile, original);
    writeJson(managedFile, managed);
    installIntegration("muse");
    installIntegration("muse");
    expect(readJson(settingsFile).managed_hooks_path).toBe("team-hooks.json");
    expect(readJson(managedFile).hooks.SessionStart).toHaveLength(2);
    expect(integrationState()).toBe("current");
    uninstallIntegration("muse");
    expect(readJson(settingsFile)).toEqual(original);
    expect(readJson(managedFile)).toEqual(managed);
  });

  it("retains hooks added to Shepherd's managed file after installation", () => {
    installIntegration("muse");
    const file = readJson(settingsFile).managed_hooks_path;
    const managed = readJson(file);
    fs.writeFileSync(path.join(integrationDir, "user-script.sh"), "echo user");
    managed.hooks.Stop.push({ hooks: [{ type: "command", command: "echo added-later" }] });
    writeJson(file, managed);
    uninstallIntegration("muse");
    expect(readJson(settingsFile).managed_hooks_path).toBe(file);
    expect(readJson(file).hooks).toEqual({ Stop: [{ hooks: [{ type: "command", command: "echo added-later" }] }] });
    expect(fs.readFileSync(path.join(integrationDir, "user-script.sh"), "utf8")).toBe("echo user");
  });

  it.skipIf(process.platform === "win32")("preserves symlinked settings and their permissions", () => {
    const target = path.join(root, "dotfiles", "muse.json");
    writeJson(target, { schema_version: 1, model: "my-model" });
    fs.chmodSync(target, 0o600);
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.symlinkSync(target, settingsFile);
    installIntegration("muse");
    expect(fs.lstatSync(settingsFile).isSymbolicLink()).toBe(true);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(readJson(target).model).toBe("my-model");
    uninstallIntegration("muse");
    expect(fs.lstatSync(settingsFile).isSymbolicLink()).toBe(true);
  });

  it("leaves an unsupported strict managed hook file untouched", () => {
    const managedFile = path.join(root, "strict.json");
    const settings = { schema_version: 1, managed_hooks_path: managedFile };
    const managed = { hooks: { SessionStart: [{ name: "team", command: "echo team", timeout_ms: 1000 }] } };
    writeJson(settingsFile, settings);
    writeJson(managedFile, managed);
    expect(() => installIntegration("muse")).toThrow("strict name/timeout_ms");
    expect(readJson(settingsFile)).toEqual(settings);
    expect(readJson(managedFile)).toEqual(managed);
    expect(fs.existsSync(integrationDir)).toBe(false);
  });
});

describe("Muse lifecycle reporting", () => {
  it("reports tasks, activity, approvals, questions, failures and review from documented payloads", async () => {
    installIntegration("muse");
    await startDaemon();
    const initial = await connection!.request({ type: "pane.create", command: "sleep 60", focus: false }) as StateView;
    const paneId = initial.panes.at(-1)!.id;
    const hook = async (body: Record<string, unknown>) => {
      const result = await run(process.execPath, [path.join(integrationDir, "shepherd-agent-state.mjs")], {
        ...process.env, SHEPHERD_ENV: "1", SHEPHERD_SOCKET_PATH: path.join(root, "daemon.sock"), SHEPHERD_PANE_ID: paneId,
      }, JSON.stringify({ session_id: "muse-session", ...body }));
      expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    };
    const pane = async () => ((await connection!.request({ type: "state.get" })) as StateView).panes.find(p => p.id === paneId)!;
    await hook({ hook_event_name: "SessionStart", source: "startup", transcript_path: "/session.jsonl" });
    expect(await pane()).toMatchObject({ agent: "muse", status: "idle", signal: { source: "integration" } });
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "Fix the retry bug" });
    expect(await pane()).toMatchObject({ status: "working", task: { title: "Fix the retry bug", checkStatus: "unknown", review: "none" } });
    await hook({ hook_event_name: "PermissionRequest", tool_name: "bash", tool_input: { command: "npm test" } });
    expect(await pane()).toMatchObject({ status: "blocked", task: { blocker: "Permission requested for bash" } });
    await expect(connection!.request({ type: "agent.send", paneId, text: "another instruction" })).rejects.toThrow("idle agent");
    await hook({ hook_event_name: "PostToolUse", tool_name: "bash", tool_response: "passed" });
    expect(await pane()).toMatchObject({ status: "working", task: { blocker: "", checkStatus: "unknown" } });
    await hook({ hook_event_name: "PreToolUse", tool_name: "request_user_input" });
    expect((await pane()).status).toBe("blocked");
    await hook({ hook_event_name: "PostToolUse", tool_name: "request_user_input" });
    await hook({ hook_event_name: "Stop", last_assistant_message: "Added retry backoff", stop_hook_active: false });
    expect((await pane()).task).toMatchObject({ summary: "Added retry backoff", checkStatus: "unknown", review: "requested" });
    expect(["done", "idle"]).toContain((await pane()).status);
    await hook({ hook_event_name: "PreLLMCall", provider: "meta" });
    expect((await pane()).status).toBe("working");
    await hook({ hook_event_name: "SessionStart", source: "compact", transcript_path: "/session.jsonl" });
    expect((await pane()).status).toBe("working");
    await hook({ hook_event_name: "StopFailure", agent_id: "child", error: "child failed" });
    expect((await pane()).status).toBe("working");
    await hook({ hook_event_name: "StopFailure", error: "api_error", error_details: "Provider unavailable" });
    expect(await pane()).toMatchObject({ status: "blocked", task: { blocker: "Provider unavailable" } });
    expect(loadState("muse")?.panes.find(p => p.id === paneId)?.agentSession)
      .toEqual({ source: "shepherd:muse", agent: "muse", value: "muse-session" });
    await hook({ hook_event_name: "SessionStart", source: "startup", transcript_path: null });
    // A memory-only session must not inherit the previous session's resume id.
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "Ephemeral task" });
    expect(loadState("muse")?.panes.find(p => p.id === paneId)?.agentSession).toBeNull();
    await hook({ hook_event_name: "SessionEnd", reason: "user_exit" });
    expect((await pane()).task?.review).toBe("requested");
  });

  it("is silent outside Shepherd, on malformed payloads and when its daemon is unavailable", async () => {
    installIntegration("muse");
    const script = path.join(integrationDir, "shepherd-agent-state.mjs");
    for (const input of ["null", "[]", "broken", JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "hello" })]) {
      expect(await run(process.execPath, [script], { ...process.env, SHEPHERD_ENV: "1", SHEPHERD_PANE_ID: "p1", SHEPHERD_SOCKET_PATH: path.join(root, "missing.sock") }, input))
        .toEqual({ code: 0, stdout: "", stderr: "" });
    }
    expect(await run(process.execPath, [script], { ...process.env, SHEPHERD_ENV: "0" }, "{}"))
      .toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it.skipIf(!process.env.SHEPHERD_TEST_MUSE_BIN)("receives real Muse echo lifecycle events through the restricted hook environment", async () => {
    installIntegration("muse");
    const requests: Record<string, unknown>[] = [];
    const server = net.createServer(socket => {
      let buffer = "";
      socket.on("data", chunk => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const request = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          requests.push(request);
          socket.write(JSON.stringify({ id: request.id, ok: true, result: {} }) + "\n");
        }
      });
    });
    const socketPath = path.join(root, "real-muse.sock");
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    try {
      const workspace = path.join(root, "workspace");
      const temporary = path.join(root, "tmp");
      fs.mkdirSync(workspace);
      fs.mkdirSync(temporary);
      expect((await run("git", ["init", "--quiet", workspace], process.env)).code).toBe(0);
      const result = await run(process.env.SHEPHERD_TEST_MUSE_BIN!, ["exec", "--workspace", workspace, "--provider", "echo", "--no-session-log", "hello shepherd"], {
        ...process.env, TMPDIR: temporary, SHEPHERD_ENV: "1", SHEPHERD_PANE_ID: "p1", SHEPHERD_SOCKET_PATH: socketPath,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("hello shepherd");
      expect(requests).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "pane.report_agent", agent: "muse", state: "working" }),
        expect.objectContaining({ type: "task.update", patch: expect.objectContaining({ title: "hello shepherd" }) }),
        expect.objectContaining({ type: "task.update", patch: expect.objectContaining({ summary: expect.stringContaining("hello shepherd"), review: "requested" }) }),
      ]));
      expect(requests.some(request => request.type === "pane.report_agent_session")).toBe(false);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 20_000);

  it.skipIf(!process.env.SHEPHERD_TEST_MUSE_BIN)("prompts the real Muse terminal UI through Shepherd agent.send", async () => {
    installIntegration("muse");
    const workspace = path.join(root, "workspace");
    const temporary = path.join(root, "tmp");
    fs.mkdirSync(workspace);
    fs.mkdirSync(temporary);
    expect((await run("git", ["init", "--quiet", workspace], process.env)).code).toBe(0);
    vi.stubEnv("TMPDIR", temporary);
    await startDaemon();
    const state = await connection!.request({
      type: "pane.create", cwd: workspace, focus: false,
      command: shellCommand([process.env.SHEPHERD_TEST_MUSE_BIN!, "--provider", "echo", "--no-session-log", "--trust-workspace", "--workspace", workspace]),
    }) as StateView;
    const paneId = state.panes.at(-1)!.id;
    const pane = async () => ((await connection!.request({ type: "state.get" })) as StateView).panes.find(p => p.id === paneId);
    await vi.waitFor(async () => expect(await pane()).toMatchObject({ agent: "muse", status: "idle" }), { timeout: 8000 })
      .catch(async error => { throw new Error(`${error}\n${JSON.stringify((await processTable()).filter(entry => entry.args.includes(workspace)))}\n${JSON.stringify(await connection!.request({ type: "pane.snapshot", paneId, rows: 50 }))}`); });
    await connection!.request({ type: "agent.send", paneId, text: "hello shepherd interactive" });
    await vi.waitFor(async () => expect((await pane())?.task)
      .toMatchObject({ summary: expect.stringContaining("hello shepherd interactive"), review: "requested" }), { timeout: 8000 });
    // Muse's final screen repaint follows its Stop hook; the detection loop
    // can still see the prior working frame until that output is parsed.
    await vi.waitFor(async () => expect(["idle", "done"]).toContain((await pane())?.status), { timeout: 3000 });
  }, 20_000);

  it("restores command-backed Muse panes by launching resume in a fresh shell", async () => {
    const bin = path.join(root, "bin");
    const log = path.join(root, "launches.jsonl");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "muse"), `#!${process.execPath}\nconst fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stdin.resume();\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
    fs.mkdirSync(path.dirname(process.env.SHEPHERD_CONFIG_PATH!), { recursive: true });
    fs.writeFileSync(process.env.SHEPHERD_CONFIG_PATH!, '[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n');
    await startDaemon();
    const state = await connection!.request({ type: "pane.create", command: "muse", cwd: root, focus: false }) as StateView;
    const paneId = state.panes.at(-1)!.id;
    await vi.waitFor(() => expect(fs.existsSync(log)).toBe(true));
    await connection!.request({ type: "pane.report_agent_session", paneId, source: "shepherd:muse", agent: "muse", sessionId: "saved-session" });
    connection!.close();
    await daemon!.stop();
    await startDaemon();
    await vi.waitFor(() => expect(fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)))
      .toEqual([[], ["resume", "saved-session"]]), { timeout: 3000 });
    const restored = await connection!.request({ type: "state.get" }) as StateView;
    expect(restored.panes.some(pane => pane.continuity === "resuming" && pane.command === null)).toBe(true);
  });
});
