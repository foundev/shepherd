import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  foregroundProcess,
  parseProcessTable,
  unwrapCommand,
} from "../src/server/processes.js";
import { ClientConnection } from "../src/client/connection.js";
import { ShepherdDaemon } from "../src/server/daemon.js";
import { connect } from "../src/transport.js";
import type { StateView } from "../src/types.js";

describe("process table", () => {
  const table = parseProcessTable([
    "  100     1   100   200 -zsh",
    "  200   100   200   200 node /usr/local/bin/claude --resume",
    "  201   200   200   200 node worker.js",
    "  300     1   300   300 -bash",
  ].join("\n"));

  it("finds the foreground job of a shell's terminal", () => {
    expect(foregroundProcess(table, 100)?.pid).toBe(200);
    // The shell itself is in the foreground.
    expect(foregroundProcess(table, 300)).toBeNull();
  });

  it("removes interpreter wrappers from command lines", () => {
    expect(unwrapCommand("node /usr/local/bin/claude --resume"))
      .toBe("/usr/local/bin/claude --resume");
    expect(unwrapCommand("/usr/bin/python3 -m aider --model x")).toBe("aider --model x");
    expect(unwrapCommand("bun --smol /opt/opencode/bin/opencode"))
      .toBe("/opt/opencode/bin/opencode");
    expect(unwrapCommand("vim notes.txt")).toBe("vim notes.txt");
  });
});

describe("foreground agent detection", () => {
  let root: string;
  let daemon: ShepherdDaemon;
  let connection: ClientConnection;
  const previousShell = process.env.SHELL;

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-fg-")));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    // A stand-in agent named like a real one.
    fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    process.env.SHELL = "/bin/sh";
    process.env.SHEPHERD_STATE_HOME = root;
    daemon = new ShepherdDaemon({ session: "fg", socketPath: path.join(root, "d.sock") });
    await daemon.start();
    connection = ClientConnection.open(await connect(path.join(root, "d.sock")));
  });

  afterAll(async () => {
    connection.close();
    await daemon.stop();
    process.env.SHELL = previousShell;
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function agentOf(paneId: string, expected: string | null): Promise<string | null> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const state = await connection.request({ type: "state.get" }) as StateView;
      const agent = state.panes.find((pane) => pane.id === paneId)?.agent ?? null;
      if (agent === expected) return agent;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const state = await connection.request({ type: "state.get" }) as StateView;
    return state.panes.find((pane) => pane.id === paneId)?.agent ?? null;
  }

  it("recognises an agent typed at a shell prompt and forgets it on exit", { timeout: 20_000 }, async () => {
    const state = await connection.request({ type: "state.get" }) as StateView;
    const paneId = state.focusedPaneId;
    expect(await agentOf(paneId, null)).toBeNull();

    // Run the stand-in by path: a login shell may reset PATH and reach a
    // real agent binary.
    await connection.request({
      type: "pane.input",
      paneId,
      data: `${path.join(root, "bin", "claude")}\r`,
    });
    expect(await agentOf(paneId, "claude")).toBe("claude");

    await connection.request({ type: "pane.input", paneId, data: "\x03" });
    expect(await agentOf(paneId, null)).toBeNull();
  });
});
