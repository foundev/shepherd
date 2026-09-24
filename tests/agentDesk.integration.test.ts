import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ShepherdDaemon } from "../src/server/daemon.js";
import { ClientConnection } from "../src/client/connection.js";
import { connect } from "../src/transport.js";
import type { AgentTask, StateView } from "../src/types.js";

describe("agent task lifecycle", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-desk-"));
  const socketPath = path.join(root, "d.sock");
  const env = { ...process.env };
  let daemon: ShepherdDaemon, connection: ClientConnection, paneId: string;
  beforeAll(async () => {
    process.env.SHEPHERD_STATE_HOME = root;
    process.env.SHEPHERD_CONFIG_PATH = path.join(root, "config.toml");
    fs.writeFileSync(process.env.SHEPHERD_CONFIG_PATH, '[terminal]\ndefault_shell="/bin/sh"\nshell_mode="non_login"\n[session]\nresume_agents_on_restore=false\n');
    daemon = new ShepherdDaemon({ session: "desk", socketPath });
    await daemon.start();
    connection = ClientConnection.open(await connect(socketPath));
    const state = await connection.request({ type: "pane.create", command: "sleep 60", focus: false }) as StateView;
    paneId = state.panes.at(-1)!.id;
  });
  afterAll(async () => {
    connection?.close(); await daemon?.stop();
    fs.rmSync(root, { force: true, recursive: true }); process.env = env;
  });

  it("preserves review requests when terminals are viewed and rejects conflicting edits", async () => {
    await connection.request({ type: "task.update", paneId, patch: { title: "Fix retry logic", checkStatus: "unknown" } });
    for (const state of ["working", "idle"] as const) await connection.request({ type: "pane.report_agent", paneId, agent: "claude", source: "fixture", state });
    await connection.request({ type: "surface.subscribe", panes: [{ paneId, cols: 80, rows: 24 }] });
    await connection.request({ type: "pane.focus-report", paneId, focused: true });
    const task = await connection.request({ type: "task.get", paneId }) as AgentTask;
    expect(task.review).toBe("requested");
    expect(task.checkStatus).toBe("unknown");
    await expect(connection.request({ type: "task.update", paneId, patch: { summary: "old edit" }, expectedRevision: 0 })).rejects.toThrow("changed");
    await connection.request({ type: "task.update", paneId, patch: { review: "reviewed" }, expectedRevision: task.revision });
    expect((await connection.request({ type: "task.get", paneId }) as AgentTask).review).toBe("reviewed");
  });

  it("rejects instructions sent to blocked or uncertain agents without changing tasks", async () => {
    for (const state of ["blocked", "unknown", "working"] as const) {
      await connection.request({ type: "pane.report_agent", paneId, agent: "claude", source: "fixture", state });
      await expect(connection.request({ type: "agent.send", paneId, text: "start another task" })).rejects.toThrow("idle agent");
    }
    expect((await connection.request({ type: "task.get", paneId }) as AgentTask).title).toBe("Fix retry logic");
    await expect(connection.request({ type: "pane.report_agent", paneId, agent: "codex", source: "fixture", state: "idle", ttlMs: -1 })).rejects.toThrow("ttlMs");
    const state = await connection.request({ type: "state.get" }) as StateView;
    expect(state.panes.find(p => p.id === paneId)?.agent).toBe("claude");
  });

  it("retains exited task output for review and restores context without rerunning completed commands", async () => {
    const state = await connection.request({ type: "pane.create", command: "printf 'review this result'; sleep 0.3; exit 1", focus: false }) as StateView;
    const finishedId = state.panes.at(-1)!.id;
    await connection.request({ type: "task.update", paneId: finishedId, patch: { title: "Inspect result", summary: "Investigate failure" } });
    await new Promise(resolve => setTimeout(resolve, 600));
    const after = await connection.request({ type: "state.get" }) as StateView;
    expect(after.panes.find(p => p.id === finishedId)).toMatchObject({ exitCode: 1, task: { review: "requested", blocker: expect.stringContaining("code 1") } });
    const snapshot = await connection.request({ type: "pane.snapshot", paneId: finishedId, rows: 10 });
    expect(JSON.stringify(snapshot)).toContain("review this result");
    connection.close(); await daemon.stop();
    daemon = new ShepherdDaemon({ session: "desk", socketPath }); await daemon.start();
    connection = ClientConnection.open(await connect(socketPath));
    const restored = await connection.request({ type: "state.get" }) as StateView;
    expect(restored.panes.find(p => p.task?.title === "Inspect result")).toMatchObject({ command: null, continuity: "restarted", task: { review: "requested", summary: "Investigate failure" } });
  });
});
