import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClientConnection } from "../src/client/connection.js";
import { ShepherdDaemon } from "../src/server/daemon.js";
import { connect } from "../src/transport.js";
import type { PaneView, StateView } from "../src/types.js";

describe("Shepherd request aliases", () => {
  let stateRoot: string;
  let socketPath: string;
  let daemon: ShepherdDaemon;
  let connection: ClientConnection;

  beforeAll(async () => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-alias-"));
    socketPath = path.join(stateRoot, "daemon.sock");
    process.env.SHEPHERD_STATE_HOME = stateRoot;
    daemon = new ShepherdDaemon({ session: "alias", socketPath });
    await daemon.start();
    connection = ClientConnection.open(await connect(socketPath));
  });

  afterAll(async () => {
    connection.close();
    await daemon.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("rejects retired request envelopes with an actionable error", async () => {
    await expect(connection.request({ method: "ping", params: {} } as never))
      .rejects.toThrow('require a "type" field');
  });

  it("supports Shepherd request aliases for workspace, pane, and agent operations", async () => {
    const ping = await aliasRequest({
      type: "ping",
    }) as { product: string; protocolVersion: number };
    expect(ping).toMatchObject({
      product: "shepherd",
      protocolVersion: 1,
    });

    const workspaces = await aliasRequest({
      type: "workspace.list",
    }) as Array<{ id: string }>;
    expect(workspaces.map((workspace) => workspace.id)).toContain("w1");

    const splitState = await aliasRequest({
      type: "pane.split",
      direction: "right",
      command: "claude --version; sleep 30",
      title: "claude",
    }) as StateView;
    expect(splitState.panes).toHaveLength(2);

    const panes = await aliasRequest({
      type: "pane.list",
    }) as PaneView[];
    expect(panes.map((pane) => pane.title)).toEqual(["", "claude"]);

    await aliasRequest({
      type: "pane.send_text",
      paneId: "p1",
      text: "printf shepherd-ready\r",
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const read = await aliasRequest({
      type: "pane.read",
      paneId: "p1",
      rows: 12,
      source: "visible",
    }) as { lines: Array<Array<{ text: string }>> };
    const text = read.lines
      .map((line) => line.map((span) => span.text).join(""))
      .join("\n");
    expect(text).toContain("shepherd-ready");

    const agents = await aliasRequest({
      type: "agent.list",
    }) as PaneView[];
    expect(agents.map((agent) => agent.agent)).toContain("claude");

    const agent = await aliasRequest({
      type: "agent.get",
      target: "claude",
    }) as PaneView;
    expect(agent.title).toBe("claude");
  });

  async function aliasRequest(
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    return await connection.request(payload as never, 10_000);
  }
}, 15_000);
