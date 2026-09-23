import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ClientConnection } from "../src/client/connection.js";
import { connect } from "../src/transport.js";
import type { StateView } from "../src/types.js";

describe("live handoff", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-handoff-")));
  const socketPath = path.join(root, "daemon.sock");
  const env = {
    ...process.env,
    SHEPHERD_STATE_HOME: root,
    SHEPHERD_SOCKET_PATH: socketPath,
    SHELL: "/bin/sh",
  };

  afterAll(async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const connection = ClientConnection.open(await connect(socketPath, 250));
        await connection.request({ type: "server.stop" });
        connection.close();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function open(): Promise<ClientConnection> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        return ClientConnection.open(await connect(socketPath, 250));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error("daemon never accepted connections");
  }

  async function screenText(connection: ClientConnection, paneId: string): Promise<string> {
    const result = await connection.request({
      type: "pane.text",
      paneId,
      start: 0,
      count: 10_000,
    }) as { lines: string[] };
    return result.lines.join("\n");
  }

  async function until(
    connection: ClientConnection,
    paneId: string,
    pattern: RegExp,
  ): Promise<RegExpMatchArray> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const match = (await screenText(connection, paneId)).match(pattern);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`pane never showed ${pattern}`);
  }

  it("keeps panes, their processes and their screens across a daemon restart", { timeout: 60_000 }, async () => {
    const daemon = spawn(process.execPath, [
      "--import",
      "tsx",
      "src/cli.ts",
      "server",
      "start",
      "--foreground",
    ], { cwd: process.cwd(), env, detached: true, stdio: "ignore" });
    daemon.unref();

    let connection = await open();
    const state = await connection.request({ type: "state.get" }) as StateView;
    const paneId = state.focusedPaneId;
    await connection.request({ type: "pane.input", paneId, data: "echo before-$$\r" });
    const before = await until(connection, paneId, /before-(\d+)/);

    const result = await connection.request({ type: "server.live_handoff" }, 45_000) as {
      handed_off: boolean;
    };
    expect(result.handed_off).toBe(true);
    connection.close();

    // The old daemon exits; the new one answers on the same socket.
    await new Promise((resolve) => setTimeout(resolve, 500));
    connection = await open();
    const after = await connection.request({ type: "state.get" }) as StateView;
    expect(after.panes.map((pane) => pane.id)).toEqual(state.panes.map((pane) => pane.id));
    expect(after.serverPid).not.toBe(state.serverPid);

    // The earlier output was replayed, and the same shell keeps running.
    expect(await screenText(connection, paneId)).toContain(`before-${before[1]}`);
    await connection.request({ type: "pane.input", paneId, data: "echo after-$$\r" });
    const again = await until(connection, paneId, /after-(\d+)/);
    expect(again[1]).toBe(before[1]);
    connection.close();
  });
});
