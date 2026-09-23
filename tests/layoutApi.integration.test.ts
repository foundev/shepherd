import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClientConnection } from "../src/client/connection.js";
import { ShepherdDaemon } from "../src/server/daemon.js";
import { connect } from "../src/transport.js";
import type { LayoutNode, StateView } from "../src/types.js";

describe("layout API", () => {
  let stateRoot: string;
  let socketPath: string;
  let daemon: ShepherdDaemon;
  let connection: ClientConnection;

  beforeAll(async () => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-layout-api-"));
    socketPath = path.join(stateRoot, "daemon.sock");
    process.env.SHEPHERD_STATE_HOME = stateRoot;
    daemon = new ShepherdDaemon({ session: "layout", socketPath });
    await daemon.start();
    connection = ClientConnection.open(await connect(socketPath));
  });

  afterAll(async () => {
    connection.close();
    await daemon.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("exports and safely reapplies tab layouts", async () => {
    await request({ type: "pane.split", direction: "right" });
    const exported = await request({
      type: "layout.export",
    }) as { tabId: string; layout: LayoutNode; paneIds: string[] };
    expect(exported.paneIds).toEqual(["p1", "p2"]);

    const reversed: LayoutNode = {
      kind: "split",
      direction: "down",
      ratio: 0.7,
      first: { kind: "pane", paneId: "p2" },
      second: { kind: "pane", paneId: "p1" },
    };
    const applied = await request({
      type: "layout.apply",
      layout: reversed,
    }) as StateView;
    expect(applied.tabs[0]?.layout).toEqual(reversed);

    await expect(request({
      type: "layout.apply",
      layout: {
        kind: "split",
        direction: "right",
        ratio: 0.5,
        first: { kind: "pane", paneId: "p1" },
        second: { kind: "pane", paneId: "p999" },
      },
    })).rejects.toThrow("layout references panes from another tab");
  });

  async function request(payload: Record<string, unknown>): Promise<unknown> {
    return await connection.request(payload as never, 10_000);
  }
}, 10_000);
