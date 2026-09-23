import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClientConnection } from "../src/client/connection.js";
import { workspaceEntries, entryLabel } from "../src/client/chrome.js";
import { ShepherdDaemon } from "../src/server/daemon.js";
import { connect } from "../src/transport.js";
import type { StateView } from "../src/types.js";

describe("expanded worktrees", () => {
  let root: string;
  let repository: string;
  let daemon: ShepherdDaemon;
  let connection: ClientConnection;
  const previousConfig = process.env.SHEPHERD_CONFIG_PATH;

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-wt-groups-")));
    repository = path.join(root, "app");
    fs.mkdirSync(repository);
    await git(repository, ["init", "-b", "main"]);
    await git(repository, ["config", "user.email", "test@example.com"]);
    await git(repository, ["config", "user.name", "Shepherd Test"]);
    fs.writeFileSync(path.join(repository, "README.md"), "# app\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "initial"]);

    fs.writeFileSync(
      path.join(root, "config.toml"),
      `[worktrees]\ndirectory = ${JSON.stringify(path.join(root, "worktrees"))}\n`,
    );
    process.env.SHEPHERD_CONFIG_PATH = path.join(root, "config.toml");
    process.env.SHEPHERD_STATE_HOME = root;
    daemon = new ShepherdDaemon({ session: "wt-groups", socketPath: path.join(root, "d.sock") });
    await daemon.start();
    connection = ClientConnection.open(await connect(path.join(root, "d.sock")));
  });

  afterAll(async () => {
    connection.close();
    await daemon.stop();
    process.env.SHEPHERD_CONFIG_PATH = previousConfig;
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function state(): Promise<StateView> {
    return await connection.request({ type: "state.get" }) as StateView;
  }

  async function until(check: (value: StateView) => boolean): Promise<StateView> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = await state();
      if (check(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("state never matched");
  }

  it("creates a worktree by branch, groups it under its repository, and removes it", async () => {
    const opened = await connection.request({
      type: "worktree.open",
      path: repository,
    }, 30_000) as StateView;
    const parentId = opened.activeWorkspaceId;

    const created = await connection.request({
      type: "worktree.create",
      workspaceId: parentId,
      branch: "feature/login",
    }, 30_000) as { worktree: { path: string; branch: string }; workspaceId: string };
    expect(created.worktree.branch).toBe("feature/login");
    expect(created.worktree.path).toBe(
      path.join(root, "worktrees", "app", "feature-login"),
    );

    const grouped = await until((value) =>
      value.workspaces.some((workspace) =>
        workspace.id === created.workspaceId && workspace.git?.linked
      ) &&
      value.workspaces.some((workspace) => workspace.id === parentId && workspace.git)
    );
    const entries = workspaceEntries(grouped.workspaces);
    const parentIndex = entries.findIndex((entry) => entry.workspace.id === parentId);
    const child = entries[parentIndex + 1];
    expect(entries[parentIndex]?.group).toBeTruthy();
    expect(child?.workspace.id).toBe(created.workspaceId);
    expect(child?.child).toEqual({ last: true });
    expect(child && entryLabel(child)).toBe("feature/login");

    await connection.request({
      type: "worktree.remove",
      workspaceId: created.workspaceId,
    }, 30_000);
    const after = await state();
    expect(after.workspaces.some((workspace) => workspace.id === created.workspaceId))
      .toBe(false);
    expect(fs.existsSync(created.worktree.path)).toBe(false);
  });
});

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} failed`)));
  });
}
