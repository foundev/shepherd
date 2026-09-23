import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupDirectory,
  loadState,
  saveState,
  snapshotDirectory,
  SNAPSHOT_INTERVAL_MS,
  SNAPSHOT_LIMIT,
  statePath,
  type PersistedState,
} from "../src/server/persistence.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function stateHome(): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-snapshots-"));
  directories.push(directory);
  process.env.SHEPHERD_STATE_HOME = directory;
}

function state(name: string): PersistedState {
  return {
    version: 2,
    activeWorkspaceId: "w1",
    workspaces: [{
      id: "w1",
      name,
      rootPath: "/tmp",
      activeTabId: "t1",
      tabs: [{
        id: "t1",
        name: "",
        focusedPaneId: "p1",
        layout: { kind: "pane", paneId: "p1" },
      }],
    }],
    panes: [{ id: "p1", title: "", command: null, cwd: "/tmp" }],
  };
}

describe("session snapshots", () => {
  it("keeps at most one snapshot per interval and prunes old ones", () => {
    stateHome();
    let now = 1_000_000;
    saveState("s", state("a"), now);
    saveState("s", state("b"), now + 1_000);
    expect(fs.readdirSync(snapshotDirectory("s"))).toHaveLength(1);
    for (let index = 0; index < SNAPSHOT_LIMIT + 5; index += 1) {
      now += SNAPSHOT_INTERVAL_MS;
      saveState("s", state(`n${index}`), now);
    }
    expect(fs.readdirSync(snapshotDirectory("s"))).toHaveLength(SNAPSHOT_LIMIT);
  });

  it("recovers from a corrupt state file using the newest snapshot", () => {
    stateHome();
    saveState("s", state("good"), 1_000_000);
    fs.writeFileSync(statePath("s"), "{ not json");
    const loaded = loadState("s", 2_000_000);
    expect(loaded?.workspaces[0]?.name).toBe("good");
    expect(fs.readdirSync(backupDirectory("s"))).toEqual(["state-2000000.json"]);
  });
});
