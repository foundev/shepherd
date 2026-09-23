import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClientConnection } from "../src/client/connection.js";
import { ShepherdDaemon } from "../src/server/daemon.js";
import { connect } from "../src/transport.js";
import type { StateView, TerminalLine } from "../src/types.js";

describe("Shepherd daemon integration", () => {
  let stateRoot: string;
  let socketPath: string;
  let daemon: ShepherdDaemon;

  beforeAll(() => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-integration-"));
    socketPath = path.join(stateRoot, "daemon.sock");
  });

  afterAll(async () => {
    await daemon.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("runs tabs, live PTY panes, zoom, and persistence end to end", async () => {
    process.env.SHEPHERD_STATE_HOME = stateRoot;
    daemon = new ShepherdDaemon({
      session: "integration",
      socketPath,
    });
    await daemon.start();

    let state = await requestState("tab.create", { name: "integration" });
    expect(state.workspaces).toHaveLength(1);
    expect(state.tabs.find((tab) => tab.id === state.activeTabId)?.name)
      .toBe("integration");

    state = await requestState("pane.create", {
      direction: "right",
      command: "printf shepherd-integration-ready; sleep 2",
      title: "marker",
    });
    expect(state.panes.map((pane) => pane.id)).toEqual(["p1", "p2", "p3"]);

    const markerPane = state.panes[state.panes.length - 1];
    expect(markerPane?.agent).toBeNull();
    await expectSnapshotToContain(markerPane?.id ?? "", "shepherd-integration-ready");

    state = await requestState("pane.rename", {
      paneId: markerPane?.id,
      title: "integration marker",
    });
    expect(state.panes.find((pane) => pane.id === markerPane?.id)?.title)
      .toBe("integration marker");

    state = await requestState("pane.zoom", {
      paneId: markerPane?.id,
      zoomed: true,
    });
    expect(state.tabs.find((tab) => tab.id === state.activeTabId)?.zoomedPaneId)
      .toBe(markerPane?.id);

    await daemon.stop();
    daemon = new ShepherdDaemon({
      session: "integration",
      socketPath,
    });
    await daemon.start();

    state = await requestState("state.get", {});
    expect(state.workspaces[0]?.name).toBe("");
    expect(state.workspaces[0]?.label).toBeTruthy();
    expect(state.tabs.find((tab) => tab.id === state.activeTabId)?.name)
      .toBe("integration");
    expect(state.panes.map((pane) => pane.id)).toEqual(["p1", "p2", "p3"]);
    expect(state.panes.find((pane) => pane.id === markerPane?.id)?.title)
      .toBe("integration marker");
  });

  async function requestState(
    type: string,
    params: Record<string, unknown>,
  ): Promise<StateView> {
    const socket = await connect(socketPath);
    const connection = ClientConnection.open(socket);
    try {
      return await connection.request({
        // The integration test deliberately covers the real daemon dispatch
        // path, so this cast is checked by the assertions below.
        ...(params as object),
        type,
      } as never) as StateView;
    } finally {
      connection.close();
    }
  }

  async function expectSnapshotToContain(
    paneId: string,
    expected: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const socket = await connect(socketPath);
      const connection = ClientConnection.open(socket);
      try {
        const snapshot = await connection.request({
          type: "pane.snapshot",
          paneId,
          rows: 12,
        }) as { lines: TerminalLine[] };
        const text = snapshot.lines
          .map((line) => line.map((span) => span.text).join(""))
          .join("\n");
        if (text.includes(expected)) return;
      } finally {
        connection.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`pane output did not contain ${expected}`);
  }
}, 20_000);
