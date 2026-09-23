import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadState,
  saveState,
  statePath,
  type LegacyPersistedState,
  type PersistedState,
} from "../src/server/persistence.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("persistence", () => {
  it("saves and loads workspace state atomically", () => {
    const stateDirectory = temporaryStateDirectory();
    const state: PersistedState = {
      version: 2,
      activeWorkspaceId: "w1",
      workspaces: [{
        id: "w1",
        name: "main",
        rootPath: "/tmp",
        activeTabId: "t1",
        tabs: [{
          id: "t1",
          name: "main",
          focusedPaneId: "p1",
          layout: { kind: "pane", paneId: "p1" },
        }],
      }],
      panes: [{
        id: "p1",
        title: "shell",
        command: null,
        cwd: "/tmp",
      }],
    };

    saveState("test", state);
    expect(loadState("test")).toEqual(state);
    expect(fs.existsSync(`${statePath("test")}.tmp`)).toBe(false);
    delete process.env.SHEPHERD_STATE_HOME;
  });

  it("migrates the tab-only v1 format", () => {
    temporaryStateDirectory();
    const legacy: LegacyPersistedState = {
      version: 1,
      activeTabId: "t1",
      tabs: [{
        id: "t1",
        name: "main",
        focusedPaneId: "p1",
        layout: { kind: "pane", paneId: "p1" },
      }],
      panes: [{
        id: "p1",
        title: "shell",
        command: null,
        cwd: "/tmp",
      }],
    };

    fs.mkdirSync(path.dirname(statePath("legacy")), { recursive: true });
    fs.writeFileSync(
      statePath("legacy"),
      JSON.stringify(legacy),
      "utf8",
    );

    expect(loadState("legacy")).toEqual({
      version: 2,
      activeWorkspaceId: "w1",
      workspaces: [{
        id: "w1",
        name: "main",
        rootPath: "/tmp",
        activeTabId: "t1",
        tabs: legacy.tabs,
      }],
      panes: legacy.panes,
    });
    delete process.env.SHEPHERD_STATE_HOME;
  });
});

function temporaryStateDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-state-"));
  temporaryDirectories.push(directory);
  process.env.SHEPHERD_STATE_HOME = directory;
  return directory;
}
