import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClientConnection } from "../src/client/connection.js";
import { openChildBridge } from "../src/remote/bridge.js";
import { ShepherdDaemon } from "../src/server/daemon.js";
import type { EventFrame, StateView } from "../src/types.js";
import { createRemoteFixture, waitFor, type RemoteFixture } from "./remoteFixture.js";

/** `shepherd server bridge` run as a plain child process, standing in for
 * the same command run over ssh. */
function spawnBridge(socketPath: string, idleTimeoutMs = 0) {
  return spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    "server",
    "bridge",
    "--idle-timeout",
    String(idleTimeoutMs),
  ], {
    cwd: process.cwd(),
    env: { ...process.env, SHEPHERD_SOCKET_PATH: socketPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("shepherd server bridge over child stdio", () => {
  let fixture: RemoteFixture;
  let daemon: ShepherdDaemon;
  let socketPath: string;

  beforeAll(async () => {
    fixture = createRemoteFixture();
    socketPath = path.join(fixture.root, "d.sock");
    process.env.SHEPHERD_STATE_HOME = path.join(fixture.root, "state");
    process.env.SHEPHERD_CONFIG_HOME = path.join(fixture.root, "config");
    daemon = new ShepherdDaemon({ session: "bridge", socketPath });
    await daemon.start();
  });

  afterAll(async () => {
    await daemon.stop();
    fixture.cleanup();
  });

  it("carries requests and events, and reconnects when the bridge drops", async () => {
    const events: EventFrame[] = [];
    const children: ReturnType<typeof spawnBridge>[] = [];
    const open = async () => {
      const child = spawnBridge(socketPath);
      children.push(child);
      return openChildBridge(child, 20_000);
    };
    const connection = ClientConnection.open(
      await open(),
      (event) => events.push(event),
      open,
      { initialDelayMs: 50, maxDelayMs: 500 },
    );
    try {
      const state = await connection.request({ type: "state.get" }) as StateView;
      expect(state.serverPid).toBe(process.pid);
      expect(state.session).toBe("bridge");

      await connection.request({ type: "events.subscribe" });
      await connection.request({ type: "workspace.create", name: "over-bridge" });
      await waitFor(() => events.some((event) => event.event === "state.changed"), Boolean);

      // Losing the bridge (ssh dying) re-spawns it with backoff.
      children[0]?.kill("SIGKILL");
      await waitFor(() => events.some((event) => event.event === "connection.lost"), Boolean);
      await waitFor(() => events.some((event) => event.event === "connection.restored"), Boolean);
      const after = await connection.request({ type: "state.get" }) as StateView;
      expect(after.workspaces.map((workspace) => workspace.name)).toContain("over-bridge");
      expect(children.length).toBeGreaterThanOrEqual(2);
    } finally {
      connection.close();
    }
  }, 60_000);

  it("closes itself after the idle timeout", async () => {
    const child = spawnBridge(socketPath, 400);
    const stream = await openChildBridge(child, 20_000);
    const exit = await new Promise<number | null>((resolve) => {
      if (child.exitCode !== null) resolve(child.exitCode);
      child.once("exit", resolve);
    });
    expect(exit).toBe(0);
    expect(stream.destroyed || stream.readableEnded).toBe(true);
  }, 30_000);

  it("starts the daemon when none is running", async () => {
    const socket = path.join(fixture.root, "fresh.sock");
    const child = spawn(process.execPath, [
      "--import", "tsx", "src/cli.ts", "server", "bridge",
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SHEPHERD_SOCKET_PATH: socket,
        SHEPHERD_STATE_HOME: path.join(fixture.root, "fresh-state"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const connection = ClientConnection.open(await openChildBridge(child, 30_000));
    try {
      const state = await connection.request({ type: "state.get" }) as StateView;
      expect(state.serverPid).not.toBe(process.pid);
      expect(fs.existsSync(socket)).toBe(true);
      await connection.request({ type: "server.stop" });
    } finally {
      connection.close();
    }
  }, 60_000);
});
