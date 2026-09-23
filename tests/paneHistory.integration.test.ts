import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClientConnection } from "../src/client/connection.js";
import { ShepherdDaemon } from "../src/server/daemon.js";
import { historyPath } from "../src/server/persistence.js";
import { connect } from "../src/transport.js";
import type { StateView } from "../src/types.js";

describe("pane screen history", () => {
  let root: string;
  let daemon: ShepherdDaemon;
  let connection: ClientConnection;
  const saved = {
    config: process.env.SHEPHERD_CONFIG_PATH,
    state: process.env.SHEPHERD_STATE_HOME,
  };

  const start = async () => {
    daemon = new ShepherdDaemon({ session: "history", socketPath: path.join(root, "d.sock") });
    await daemon.start();
    connection = ClientConnection.open(await connect(path.join(root, "d.sock")));
  };
  const screenText = async (paneId: string) => {
    const text = await connection.request({ type: "pane.text", paneId, start: 0, count: 1_000 }) as {
      lines: string[];
    };
    return text.lines.join("\n");
  };

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-history-")));
    process.env.SHEPHERD_CONFIG_PATH = path.join(root, "config.toml");
    process.env.SHEPHERD_STATE_HOME = root;
    fs.writeFileSync(process.env.SHEPHERD_CONFIG_PATH, "[experimental]\npane_history = true\n");
    await start();
  });

  afterAll(async () => {
    connection.close();
    await daemon.stop();
    for (const [key, value] of [
      ["SHEPHERD_CONFIG_PATH", saved.config],
      ["SHEPHERD_STATE_HOME", saved.state],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("replays saved output after a restart and removes it when turned off", async () => {
    const state = await connection.request({ type: "state.get" }) as StateView;
    const paneId = state.focusedPaneId;
    await connection.request({ type: "pane.input", paneId, data: "echo history-$((6*7))\r" });
    for (let attempt = 0; attempt < 50 && !(await screenText(paneId)).includes("history-42"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    connection.close();
    await daemon.stop();
    const file = historyPath("history");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toContain("history-42");

    await start();
    const restored = await connection.request({ type: "state.get" }) as StateView;
    expect(await screenText(restored.focusedPaneId)).toContain("history-42");

    // Turning it off drops the saved history.
    connection.close();
    await daemon.stop();
    fs.writeFileSync(process.env.SHEPHERD_CONFIG_PATH ?? "", "");
    await start();
    for (let attempt = 0; attempt < 40 && fs.existsSync(file); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(fs.existsSync(file)).toBe(false);
  }, 20_000);
});
