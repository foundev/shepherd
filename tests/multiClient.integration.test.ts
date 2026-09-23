import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClientConnection } from "../src/client/connection.js";
import { ShepherdDaemon } from "../src/server/daemon.js";
import { connect } from "../src/transport.js";
import type { StateView } from "../src/types.js";

describe("multiple attached clients", () => {
  let stateRoot: string;
  let socketPath: string;
  let daemon: ShepherdDaemon;
  let first: ClientConnection;
  let second: ClientConnection;

  beforeAll(async () => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-clients-"));
    socketPath = path.join(stateRoot, "daemon.sock");
    process.env.SHEPHERD_STATE_HOME = stateRoot;
    daemon = new ShepherdDaemon({ session: "clients", socketPath });
    await daemon.start();
    first = ClientConnection.open(await connect(socketPath));
    second = ClientConnection.open(await connect(socketPath));
  });

  afterAll(async () => {
    first.close();
    second.close();
    await daemon.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("gives each client an independent workspace and tab view", async () => {
    const firstInitial = await state(first);
    const secondInitial = await state(second);
    expect(firstInitial.clientId).toBe("c1");
    expect(secondInitial.clientId).toBe("c2");
    expect(firstInitial.activeWorkspaceId).toBe("w1");
    expect(secondInitial.activeWorkspaceId).toBe("w1");

    const firstCreated = await first.request({
      type: "workspace.create",
      name: "research",
    }) as StateView;
    expect(firstCreated.activeWorkspaceId).toBe("w2");
    expect(firstCreated.workspaces).toHaveLength(2);

    const secondAfterCreate = await state(second);
    expect(secondAfterCreate.activeWorkspaceId).toBe("w1");
    expect(secondAfterCreate.workspaces).toHaveLength(2);

    const firstSplit = await first.request({
      type: "pane.create",
      direction: "right",
    }) as StateView;
    const secondSplit = await second.request({
      type: "pane.create",
      direction: "down",
    }) as StateView;

    expect(firstSplit.activeWorkspaceId).toBe("w2");
    expect(firstSplit.tabs[0]?.layout).toMatchObject({
      direction: "right",
    });
    expect(secondSplit.activeWorkspaceId).toBe("w1");
    expect(secondSplit.tabs[0]?.layout).toMatchObject({
      direction: "down",
    });

    const firstFinal = await state(first);
    const secondFinal = await state(second);
    expect(firstFinal.activeWorkspaceId).toBe("w2");
    expect(secondFinal.activeWorkspaceId).toBe("w1");
    expect(firstFinal.focusedPaneId).not.toBe(secondFinal.focusedPaneId);
  });

  async function state(connection: ClientConnection): Promise<StateView> {
    return await connection.request({ type: "state.get" }) as StateView;
  }
}, 10_000);
