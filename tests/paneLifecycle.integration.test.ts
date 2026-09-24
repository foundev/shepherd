import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClientConnection } from "../src/client/connection.js";
import { ShepherdDaemon } from "../src/server/daemon.js";
import { paneIds } from "../src/server/layout.js";
import { connect } from "../src/transport.js";
import type { StateView } from "../src/types.js";

describe("pane lifecycle", () => {
  let stateRoot: string;
  let socketPath: string;
  let daemon: ShepherdDaemon;
  let connection: ClientConnection;

  beforeAll(async () => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-lifecycle-"));
    socketPath = path.join(stateRoot, "daemon.sock");
    process.env.SHEPHERD_STATE_HOME = stateRoot;
    daemon = new ShepherdDaemon({ session: "lifecycle", socketPath });
    await daemon.start();
    connection = ClientConnection.open(await connect(socketPath));
  });

  afterAll(async () => {
    connection.close();
    await daemon.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  async function request(payload: Record<string, unknown>): Promise<StateView> {
    return await connection.request(payload as never) as StateView;
  }

  async function waitForState(
    check: (state: StateView) => boolean,
  ): Promise<StateView> {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const state = await request({ type: "state.get" });
      if (check(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("state never matched");
  }

  it("removes an exited pane and returns focus to the previous pane", async () => {
    let state = await request({ type: "state.get" });
    const shellPane = state.focusedPaneId;
    state = await request({
      type: "pane.create",
      direction: "right",
      command: "sleep 0.3",
    });
    const exitingPane = state.focusedPaneId;
    expect(exitingPane).not.toBe(shellPane);

    state = await waitForState((next) =>
      !next.panes.some((pane) => pane.id === exitingPane)
    );
    expect(state.focusedPaneId).toBe(shellPane);
  });

  it("closes the tab when its last pane exits", async () => {
    let state = await request({ type: "tab.create", name: "short-lived" });
    const tabId = state.activeTabId;
    await request({
      type: "pane.input",
      paneId: state.focusedPaneId,
      data: "exit\r",
    });
    state = await waitForState((next) =>
      !next.workspaces.some((workspace) =>
        workspace.tabs.some((tab) => tab.id === tabId)
      )
    );
    expect(state.tabs.some((tab) => tab.id === tabId)).toBe(false);
  });

  it("closes an interactive shell with task context when it exits", async () => {
    let state = await request({ type: "tab.create", name: "shell task" });
    const shellPaneId = state.focusedPaneId;
    await connection.request({
      type: "task.update",
      paneId: shellPaneId,
      patch: { title: "Shell-backed task" },
    });
    await request({
      type: "pane.input",
      paneId: shellPaneId,
      data: "exit\r",
    });

    state = await waitForState((next) =>
      !next.panes.some((pane) => pane.id === shellPaneId)
    );
    expect(state.workspaces.some((workspace) =>
      workspace.tabs.some((tab) => paneIds(tab.layout).includes(shellPaneId))
    )).toBe(false);
  });

  it("starts new panes in the workspace root by default", async () => {
    const state = await request({ type: "pane.create", direction: "down" });
    const workspace = state.workspaces.find((entry) =>
      entry.id === state.activeWorkspaceId
    );
    const pane = state.panes.find((entry) => entry.id === state.focusedPaneId);
    expect(pane?.cwd).toBeTruthy();
    expect(fs.existsSync(pane?.cwd ?? "")).toBe(true);
    expect(workspace?.rootPath).toBeTruthy();
  });
});
