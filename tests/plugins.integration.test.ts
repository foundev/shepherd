import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClientConnection } from "../src/client/connection.js";
import { ShepherdDaemon } from "../src/server/daemon.js";
import { connect } from "../src/transport.js";

describe("Shepherd local plugins", () => {
  let stateRoot: string;
  let socketPath: string;
  let daemon: ShepherdDaemon;
  let pluginRoot: string;

  beforeAll(() => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-plugin-int-"));
    socketPath = path.join(stateRoot, "daemon.sock");
    pluginRoot = path.join(stateRoot, "example-plugin");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "shepherd-plugin.toml"),
      [
        'id = "example.integration"',
        'name = "Integration Plugin"',
        'version = "0.1.0"',
        "",
        "[[actions]]",
        'id = "context"',
        'title = "Print context"',
        'command = ["node", "-e", "console.log(process.env.SHEPHERD_PLUGIN_ID + \':\' + process.env.SHEPHERD_PLUGIN_ACTION_ID)"]',
      ].join("\n"),
      "utf8",
    );
  });

  afterAll(async () => {
    await daemon.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("links, invokes, disables, and restores local plugins", async () => {
    process.env.SHEPHERD_STATE_HOME = stateRoot;
    daemon = new ShepherdDaemon({ session: "plugins", socketPath });
    await daemon.start();

    const linked = await request({
      type: "plugin.link",
      path: pluginRoot,
    });
    expect(linked).toMatchObject({
      id: "example.integration",
      enabled: true,
      actions: [{
        id: "context",
        title: "Print context",
      }],
    });

    const invocation = await request({
      type: "plugin.action-invoke",
      pluginId: "example.integration",
      actionId: "context",
    }, 35_000);
    expect(invocation).toMatchObject({
      pluginId: "example.integration",
      actionId: "context",
      exitCode: 0,
      timedOut: false,
    });
    expect(invocation.stdout).toContain("example.integration:context");

    const disabled = await request({
      type: "plugin.set-enabled",
      pluginId: "example.integration",
      enabled: false,
    });
    expect(disabled).toMatchObject({ id: "example.integration", enabled: false });
    await expect(request({
      type: "plugin.action-invoke",
      pluginId: "example.integration",
      actionId: "context",
    })).rejects.toThrow("plugin is disabled: example.integration");

    await daemon.stop();
    daemon = new ShepherdDaemon({ session: "plugins", socketPath });
    await daemon.start();
    const state = await request({ type: "state.get" }) as {
      plugins: Array<{ id: string; enabled: boolean }>;
    };
    expect(state.plugins.map((plugin) => ({
      id: plugin.id,
      enabled: plugin.enabled,
    }))).toEqual([{
      id: "example.integration",
      enabled: false,
    }]);
  });

  async function request(
    payload: Record<string, unknown>,
    timeoutMs = 4_000,
  ): Promise<Record<string, unknown>> {
    const socket = await connect(socketPath);
    const connection = ClientConnection.open(socket);
    try {
      return await connection.request(
        payload as never,
        timeoutMs,
      ) as Record<string, unknown>;
    } finally {
      connection.close();
    }
  }
}, 20_000);
