import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  installIntegration,
  listIntegrations,
  uninstallIntegration,
} from "../src/server/integrations.js";
import { resumeArgv, shellCommand } from "../src/server/agentSessions.js";
import { ClientConnection } from "../src/client/connection.js";
import { ShepherdDaemon } from "../src/server/daemon.js";
import { loadState } from "../src/server/persistence.js";
import { connect } from "../src/transport.js";
import type { StateView } from "../src/types.js";

describe("agent resume commands", () => {
  it("builds each agent's native resume command for official sources", () => {
    expect(resumeArgv({ source: "shepherd:claude", agent: "claude", value: "abc" }))
      .toEqual(["claude", "--resume", "abc"]);
    expect(resumeArgv({ source: "shepherd:codex", agent: "codex", value: "x1" }))
      .toEqual(["codex", "resume", "x1"]);
    expect(resumeArgv({ source: "shepherd:copilot", agent: "copilot", value: "s" }))
      .toEqual(["copilot", "--resume=s"]);
    expect(resumeArgv({ source: "someone:claude", agent: "claude", value: "abc" })).toBeNull();
    expect(resumeArgv({ source: "shepherd:claude", agent: "claude", value: "--evil" })).toBeNull();
    expect(shellCommand(["claude", "--resume", "a b'c"])).toBe("claude --resume 'a b'\\''c'");
  });
});

describe("Claude integration", () => {
  let root: string;
  let daemon: ShepherdDaemon;
  let connection: ClientConnection;
  const saved = {
    claude: process.env.CLAUDE_CONFIG_DIR,
    config: process.env.SHEPHERD_CONFIG_PATH,
  };

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-int-")));
    // Never touch the real ~/.claude or ~/.config/shepherd.
    process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
    process.env.SHEPHERD_CONFIG_PATH = path.join(root, "config", "config.toml");
    process.env.SHEPHERD_STATE_HOME = root;
    fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({
      model: "opus",
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo mine" }] }] },
    }));
    daemon = new ShepherdDaemon({ session: "int", socketPath: path.join(root, "d.sock") });
    await daemon.start();
    connection = ClientConnection.open(await connect(path.join(root, "d.sock")));
  });

  afterAll(async () => {
    connection.close();
    await daemon.stop();
    process.env.CLAUDE_CONFIG_DIR = saved.claude;
    process.env.SHEPHERD_CONFIG_PATH = saved.config;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function settings(): { model?: string; hooks?: { SessionStart?: unknown[] } } {
    return JSON.parse(fs.readFileSync(
      path.join(process.env.CLAUDE_CONFIG_DIR ?? "", "settings.json"),
      "utf8",
    ));
  }

  it("installs a SessionStart hook beside the user's own hooks", () => {
    expect(listIntegrations().find((entry) => entry.target === "claude")?.state)
      .toBe("not_installed");
    installIntegration("claude");
    installIntegration("claude");
    const hooks = JSON.stringify(settings().hooks?.SessionStart);
    expect(settings().model).toBe("opus");
    expect(hooks).toContain("echo mine");
    expect(hooks.match(/shepherd-agent-state/g)).toHaveLength(1);
    expect(listIntegrations().find((entry) => entry.target === "claude")?.state)
      .toBe("current");
  });

  it("marks earlier hook versions outdated and upgrades them on reinstall", () => {
    const script = path.join(root, "config", "integrations", "claude", "shepherd-agent-state.mjs");
    fs.writeFileSync(script, "// shepherd-agent-state 1: earlier protocol\n");
    expect(listIntegrations().find((entry) => entry.target === "claude")?.state).toBe("outdated");
    installIntegration("claude");
    expect(listIntegrations().find((entry) => entry.target === "claude")?.state).toBe("current");
  });

  it("reports task context and lifecycle without treating a response as passing checks", async () => {
    const state = await connection.request({ type: "pane.create", command: "sleep 30", focus: false }) as StateView;
    const paneId = state.panes.at(-1)!.id;
    const script = path.join(root, "config", "integrations", "claude", "shepherd-agent-state.mjs");
    const hook = (body: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [script], { env: { ...process.env, SHEPHERD_ENV: "1", SHEPHERD_PANE_ID: paneId, SHEPHERD_SOCKET_PATH: path.join(root, "d.sock") }, stdio: ["pipe", "ignore", "pipe"] });
      let error = ""; child.stderr.on("data", chunk => { error += chunk; });
      child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error(error)));
      child.stdin.end(JSON.stringify(body));
    });
    const pane = async () => ((await connection.request({ type: "state.get" })) as StateView).panes.find(p => p.id === paneId)!;
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "Fix retry logic" });
    expect(await pane()).toMatchObject({ status: "working", task: { title: "Fix retry logic", review: "none" }, signal: { source: "integration" } });
    await hook({ hook_event_name: "PermissionRequest", tool_name: "Bash" });
    expect(await pane()).toMatchObject({ status: "blocked", task: { blocker: "Permission requested for Bash" } });
    await hook({ hook_event_name: "PostToolUse", tool_name: "Bash" });
    expect(await pane()).toMatchObject({ status: "working", task: { blocker: "" } });
    await hook({ hook_event_name: "Stop", last_assistant_message: "Added retry backoff", background_tasks: [] });
    expect((await pane()).task).toMatchObject({ summary: "Added retry backoff", checkStatus: "unknown", review: "requested" });
    await hook({ hook_event_name: "Stop", agent_id: "child", last_assistant_message: "Child work" });
    expect((await pane()).task?.summary).toBe("Added retry backoff");
    await connection.request({ type: "pane.close", paneId });
  });

  it("reports the Claude session from a pane and saves it for resume", async () => {
    const state = await connection.request({ type: "state.get" }) as StateView;
    const paneId = state.focusedPaneId;
    const script = path.join(root, "config", "integrations", "claude", "shepherd-agent-state.mjs");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [script, "session"], {
        env: {
          ...process.env,
          SHEPHERD_ENV: "1",
          SHEPHERD_PANE_ID: paneId,
          SHEPHERD_SOCKET_PATH: path.join(root, "d.sock"),
        },
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.on("error", reject);
      child.on("close", () => resolve());
      child.stdin.end(JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "session-123",
        source: "startup",
      }));
    });
    const after = await connection.request({ type: "state.get" }) as StateView;
    expect(after.panes.find((pane) => pane.id === paneId)?.agent).toBe("claude");

    await daemon.stop();
    const persisted = loadState("int");
    expect(persisted?.panes.find((pane) => pane.id === paneId)?.agentSession).toEqual({
      source: "shepherd:claude",
      agent: "claude",
      value: "session-123",
    });
    // Resuming would launch the real agent; disable it for the restart.
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.writeFileSync(process.env.SHEPHERD_CONFIG_PATH ?? "", "[session]\nresume_agents_on_restore = false\n");
    daemon = new ShepherdDaemon({ session: "int", socketPath: path.join(root, "d.sock") });
    await daemon.start();
    connection = ClientConnection.open(await connect(path.join(root, "d.sock")));
  });

  it("removes only its own hook", () => {
    uninstallIntegration("claude");
    const hooks = JSON.stringify(settings().hooks?.SessionStart);
    expect(hooks).toContain("echo mine");
    expect(hooks).not.toContain("shepherd-agent-state");
  });
});
