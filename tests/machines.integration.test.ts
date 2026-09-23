import { spawn } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClientConnection } from "../src/client/connection.js";
import {
  addMachine,
  loadMachines,
  saveMachines,
  updateMachine,
} from "../src/machines.js";
import { openRemoteAttach } from "../src/remote/attach.js";
import { ShepherdDaemon } from "../src/server/daemon.js";
import { connect } from "../src/transport.js";
import type { RemoteMachineView, StateView } from "../src/types.js";
import { createRemoteFixture, waitFor, type RemoteFixture } from "./remoteFixture.js";

describe("saved machines over a persistent ssh bridge", () => {
  let fixture: RemoteFixture;
  let socketPath: string;
  let configRoot: string;
  let daemon: ShepherdDaemon;
  const originalPath = process.env.PATH;

  beforeAll(async () => {
    fixture = createRemoteFixture();
    socketPath = path.join(fixture.root, "local.sock");
    configRoot = path.join(fixture.root, "config");
    process.env.SHEPHERD_STATE_HOME = path.join(fixture.root, "state");
    process.env.SHEPHERD_CONFIG_HOME = configRoot;
    process.env.SHEPHERD_SSH_RUNTIME_DIR = fixture.runtimeDir;
    process.env.PATH = `${fixture.sshBin}${path.delimiter}${originalPath}`;
    const edge = addMachine({ version: 1, machines: [] }, "edge", "deploy@example.com", 2222);
    saveMachines(addMachine(edge.file, "bare", "bare.example.com").file);
    daemon = new ShepherdDaemon({ session: "machines", socketPath });
    await daemon.start();
  }, 30_000);

  afterAll(async () => {
    await daemon.stop();
    await fixture.stopRemoteDaemon();
    process.env.PATH = originalPath;
    delete process.env.SHEPHERD_SSH_RUNTIME_DIR;
    fixture.cleanup();
  });

  it("connects on use, reads remote state, and runs pane operations", async () => {
    const initial = await requestState();
    expect(initial.machines[0]).toMatchObject({
      id: "m1",
      label: "edge",
      target: "deploy@example.com",
      port: 2222,
      status: "idle",
      reachable: false,
      enabled: true,
      remoteSession: null,
      remote: null,
    });

    const refreshed = await request({ type: "machine.refresh", labelOrId: "edge" }, 60_000) as
      unknown as RemoteMachineView;
    expect(refreshed.error).toBeNull();
    expect(refreshed.status).toBe("online");
    expect(refreshed.reachable).toBe(true);
    expect(refreshed.remote?.serverPid).not.toBe(process.pid);
    expect(refreshed.remote?.workspaceList.length).toBeGreaterThan(0);

    // One bridge, run through the generated config and shared master.
    const bridgeLines = fixture.sshLines().filter((line) => line.includes("server bridge"));
    expect(bridgeLines).toHaveLength(1);
    expect(bridgeLines[0]).toContain(`-F ${fixture.runtimeDir}`);
    expect(bridgeLines[0]).toContain("BatchMode=yes");
    expect(bridgeLines[0]).toContain("ControlMaster=auto");
    expect(bridgeLines[0]).toContain(`ControlPath=${fixture.runtimeDir}/%C`);
    expect(bridgeLines[0]).toContain("-p 2222 -- deploy@example.com");
    expect(bridgeLines[0]).toContain("server bridge --idle-timeout 60000");

    const paneId = refreshed.remote?.panes[0]?.paneId ?? "";
    expect(paneId).not.toBe("");
    await request({
      type: "machine.pane-input",
      labelOrId: "edge",
      paneId,
      data: "echo remote-bridge-ok",
    }, 30_000);
    const read = await waitFor(
      () => request({
        type: "machine.pane-read",
        labelOrId: "edge",
        paneId,
        rows: 40,
        source: "recent-unwrapped",
      }, 30_000) as Promise<{ value: string }>,
      (value) => /^remote-bridge-ok\s*$/m.test(value.value),
    );
    expect(read.value).toContain("remote-bridge-ok");

    const agent = await request({ type: "machine.agent-get", labelOrId: "edge", target: paneId }, 30_000) as
      { kind: string; value: string };
    expect(agent.kind).toBe("get");
    expect(JSON.parse(agent.value).id).toBe(paneId);

    const forwarded = await request({
      type: "machine.request",
      labelOrId: "edge",
      request: { type: "workspace.create", name: "from-local" },
    }, 30_000) as StateView;
    expect(forwarded.workspaces.map((workspace) => workspace.name)).toContain("from-local");
    // Remote events keep the cached state current.
    await waitFor(requestState, (state) =>
      Boolean(state.machines[0]?.remote?.workspaceList.some((workspace) => workspace.name === "from-local"))
    );

    // All of that went over the same bridge.
    expect(fixture.sshLines().filter((line) => line.includes("server bridge"))).toHaveLength(1);
  }, 90_000);

  it("marks a machine without Shepherd as needing attention", async () => {
    const view = await request({ type: "machine.refresh", labelOrId: "bare" }, 60_000) as
      unknown as RemoteMachineView;
    expect(view.status).toBe("attention");
    expect(view.error).toContain("not installed");
  }, 60_000);

  it("disconnects disabled machines and applies file changes", async () => {
    saveMachines(updateMachine(loadMachines(), "edge", { enabled: false, label: "Edge box" }).file);
    await request({ type: "machine.sync" });
    const state = await requestState();
    expect(state.machines[0]).toMatchObject({
      label: "Edge box",
      status: "disabled",
      enabled: false,
      reachable: false,
    });
    await expect(request({ type: "machine.pane-read", labelOrId: "m1", paneId: "p1" }))
      .rejects.toThrow("disabled");
    saveMachines(updateMachine(loadMachines(), "m1", { enabled: true }).file);
    // The daemon notices machines.json changes by itself.
    await waitFor(requestState, (next) => next.machines[0]?.status === "idle");
  }, 30_000);

  it("forwards Shepherd commands and explains a missing install", async () => {
    const status = await runCli(["machine", "exec", "m1", "--", "server", "status"]);
    expect(status.stderr).toBe("");
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout).serverPid).toBeTypeOf("number");

    const machineStatus = await runCli(["machine", "status", "edge box"]);
    expect(machineStatus.exitCode).toBe(0);
    expect(JSON.parse(machineStatus.stdout).workspaces.length).toBeGreaterThan(0);

    const missing = await runCli(["machine", "exec", "bare", "--", "server", "status"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("shepherd was not found on bare.example.com");

    const remoteMissing = await runCli(["--remote", "bare.example.com"]);
    expect(remoteMissing.exitCode).toBe(1);
    expect(remoteMissing.stderr).toContain("shepherd was not found on bare.example.com");
    expect(remoteMissing.stderr).toContain("does not copy");
  }, 90_000);

  it("adds, renames, disables and lists machines from the CLI", async () => {
    const rejected = await runCli(["machine", "add", "bare.example.com", "--label", "Nothing here"]);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("was not saved");
    expect(loadMachines().machines.map((entry) => entry.label)).not.toContain("Nothing here");

    const added = await runCli([
      "machine", "add", "ssh://deploy@example.com:2200", "--label", "Build machine",
    ]);
    expect(added.exitCode).toBe(0);
    const saved = JSON.parse(added.stdout);
    expect(saved).toMatchObject({ label: "Build machine", port: 2200, host: "example.com" });

    expect((await runCli(["machine", "rename", saved.id, "--label", "Builder"])).exitCode).toBe(0);
    expect((await runCli(["machine", "disable", "builder"])).exitCode).toBe(0);
    const listed = JSON.parse((await runCli(["machine", "list", "--json"])).stdout) as Array<{
      id: string;
      label: string;
      enabled: boolean;
    }>;
    expect(listed.find((entry) => entry.id === saved.id)).toMatchObject({
      label: "Builder",
      enabled: false,
    });
    // Older positional form still works.
    const legacy = await runCli(["machine", "add", "legacy", "deploy@legacy.example.com", "--port", "2022"]);
    expect(JSON.parse(legacy.stdout)).toMatchObject({ label: "legacy", port: 2022 });
  }, 90_000);

  it("attaches a local client with --remote semantics", async () => {
    const remote = await openRemoteAttach({
      endpoint: { user: "deploy", host: "example.com", port: 2222 },
      session: null,
      manageSshConfig: true,
    });
    try {
      const state = await remote.connection.request({ type: "state.get" }) as StateView;
      expect(state.serverPid).not.toBe(process.pid);
      const keys = await remote.fetchRemoteKeys();
      expect(keys?.prefix).toBe("ctrl+b");
      const privateLines = fixture.sshLines().filter((line) =>
        line.includes(`ControlPath=${fixture.runtimeDir}/a${process.pid}-%C`)
      );
      expect(privateLines.length).toBeGreaterThan(0);
    } finally {
      await remote.close();
    }
  }, 60_000);

  async function runCli(args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SHEPHERD_SOCKET_PATH: socketPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    return { exitCode, stdout, stderr };
  }

  async function requestState() {
    return await request({ type: "state.get" }) as unknown as StateView;
  }

  async function request(
    payload: Record<string, unknown>,
    timeout = 4_000,
  ): Promise<Record<string, unknown>> {
    const socket = await connect(socketPath);
    const connection = ClientConnection.open(socket);
    try {
      return await connection.request(
        payload as never,
        timeout,
      ) as Record<string, unknown>;
    } finally {
      connection.close();
    }
  }
});
