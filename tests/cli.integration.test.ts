import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ClientConnection } from "../src/client/connection.js";
import { connect } from "../src/transport.js";
import type { PaneView, StateView } from "../src/types.js";

describe("Shepherd CLI daemon startup", () => {
  const stateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "shepherd-cli-integration-"),
  );
  const socketPath = path.join(stateRoot, "daemon.sock");

  afterAll(async () => {
    // A slow startup may still be coming up; keep trying so no daemon leaks.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const socket = await connect(socketPath, 250);
        const connection = ClientConnection.open(socket);
        await connection.request({ type: "server.stop" });
        connection.close();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("returns after starting a detached daemon instead of holding the socket", async () => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "server", "start"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SHEPHERD_STATE_HOME: stateRoot,
          SHEPHERD_SOCKET_PATH: socketPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    const exitCode = await Promise.race([
      new Promise<number | null>((resolve) => {
        child.once("exit", resolve);
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("server start did not return")), 4_000);
      }),
    ]);

    expect(exitCode).toBe(0);
    expect(output).toContain(socketPath);
  });

  it("reports invalid plugin sources without a stack trace", async () => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "plugin",
        "install",
        "https://github.com/example/example",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("exit", resolve);
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "plugin install accepts only owner/repo[/subdir] GitHub shorthand",
    );
    expect(stderr).not.toContain("at ");
  });

  it("creates a background pane and types, submits, and waits for its output", async () => {
    const connection = ClientConnection.open(await connect(socketPath));
    let paneId: string | undefined;
    try {
      const before = await connection.request({ type: "state.get" }) as StateView;
      const created = await runCli(["pane", "split", "--direction", "down", "--no-focus"]);
      expect(created.exitCode, created.stderr).toBe(0);
      paneId = (JSON.parse(created.stdout) as PaneView).id;
      expect((await connection.request({ type: "state.get" }) as StateView).focusedPaneId)
        .toBe(before.focusedPaneId);
      const typed = await runCli(["pane", "type", paneId, "printf 'shepherd-%s\\n' cli-ready"]);
      expect(typed.exitCode, typed.stderr).toBe(0);
      expect((await runCli(["pane", "write", paneId, ""])).exitCode).toBe(0);
      const waited = await runCli(["pane", "wait-output", paneId, "shepherd-cli-ready", "--timeout", "3000"]);
      expect(waited.exitCode, waited.stderr).toBe(0);
      expect(JSON.parse(waited.stdout)).toMatchObject({ paneId, found: true });
      const timeout = await runCli(["pane", "wait-output", paneId, "not-present-71a3", "--timeout", "0"]);
      expect(timeout.exitCode).toBe(1);
      expect(timeout.stderr).toContain("timed out waiting");

      await connection.request({ type: "pane.report_agent", paneId, source: "test", agent: "claude", state: "blocked" });
      const blocked = await runCli(["agent", "prompt", paneId, "do not submit this"]);
      expect(blocked.exitCode).toBe(1);
      expect(blocked.stderr).toContain("needs attention");
    } finally {
      if (paneId) await connection.request({ type: "pane.close", paneId });
      connection.close();
    }
  }, 15_000);

  function runCli(args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
        env: { ...process.env, SHEPHERD_STATE_HOME: stateRoot, SHEPHERD_SOCKET_PATH: socketPath },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    });
  }
}, 10_000);
