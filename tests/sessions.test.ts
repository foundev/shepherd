import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("named sessions", () => {
  it("lists and deletes saved sessions without starting their daemons", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-sessions-"));
    temporaryDirectories.push(root);
    const alpha = path.join(root, "alpha");
    fs.mkdirSync(alpha, { recursive: true });
    fs.writeFileSync(path.join(alpha, "state.json"), "{}", "utf8");

    const list = await runSessionCommand([
      "session",
      "list",
    ], root);
    expect(JSON.parse(list.stdout)).toEqual([{
      name: "alpha",
      statePath: path.join(alpha, "state.json"),
      socketPath: path.join(alpha, "daemon.sock"),
      running: false,
      serverPid: null,
      workspaces: 0,
      panes: 0,
    }]);

    const deleted = await runSessionCommand([
      "session",
      "delete",
      "alpha",
      "--yes",
    ], root);
    expect(JSON.parse(deleted.stdout)).toEqual({
      name: "alpha",
      deleted: true,
    });
    expect(fs.existsSync(alpha)).toBe(false);
  });
});

async function runSessionCommand(
  args: string[],
  stateRoot: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", ...args],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SHEPHERD_STATE_HOME: stateRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
  });
  return { stdout, stderr, exitCode };
}
