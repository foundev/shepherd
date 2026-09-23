import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClientConnection } from "../src/client/connection.js";
import { ShepherdDaemon } from "../src/server/daemon.js";
import { connect } from "../src/transport.js";

describe("Git worktree integration", () => {
  let stateRoot: string;
  let repositoryRoot: string;
  let worktreePath: string;
  let socketPath: string;
  let daemon: ShepherdDaemon;
  let connection: ClientConnection;

  beforeAll(async () => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-worktrees-"));
    stateRoot = fs.realpathSync(stateRoot);
    repositoryRoot = path.join(stateRoot, "repository");
    worktreePath = path.join(stateRoot, "feature-worktree");
    socketPath = path.join(stateRoot, "daemon.sock");
    fs.mkdirSync(repositoryRoot, { recursive: true });
    await git(repositoryRoot, ["init", "-b", "main"]);
    await git(repositoryRoot, ["config", "user.email", "test@example.com"]);
    await git(repositoryRoot, ["config", "user.name", "Shepherd Test"]);
    fs.writeFileSync(path.join(repositoryRoot, "README.md"), "# test\n");
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, ["commit", "-m", "initial commit"]);

    process.env.SHEPHERD_STATE_HOME = stateRoot;
    daemon = new ShepherdDaemon({ session: "worktrees", socketPath });
    await daemon.start();
    connection = ClientConnection.open(await connect(socketPath));
  });

  afterAll(async () => {
    connection.close();
    await daemon.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("lists, creates, opens, and removes workspaces backed by worktrees", async () => {
    const initial = await request({
      type: "worktree.list",
      root: repositoryRoot,
    }) as Array<{ path: string }>;
    expect(initial.map((worktree) => worktree.path)).toEqual([repositoryRoot]);

    const created = await request({
      type: "worktree.create",
      root: repositoryRoot,
      path: worktreePath,
      branch: "shepherd-feature",
      createBranch: true,
    }, 30_000) as { path: string; branch: string | null };
    expect(created).toMatchObject({
      path: worktreePath,
      branch: "shepherd-feature",
    });
    expect(fs.existsSync(path.join(worktreePath, "README.md"))).toBe(true);

    const opened = await request({
      type: "worktree.open",
      path: worktreePath,
      name: "feature",
    }) as {
      activeWorkspaceId: string;
      workspaces: Array<{ rootPath: string }>;
    };
    expect(opened.workspaces.map((workspace) => workspace.rootPath))
      .toContain(worktreePath);
    const openedWorkspaceId = opened.activeWorkspaceId;

    await request({
      type: "workspace.close",
      workspaceId: openedWorkspaceId,
    });
    const removed = await request({
      type: "worktree.remove",
      root: repositoryRoot,
      path: worktreePath,
    }, 30_000) as { removed: boolean };
    expect(removed.removed).toBe(true);
    expect(fs.existsSync(worktreePath)).toBe(false);
  });

  async function request(
    payload: Record<string, unknown>,
    timeout = 10_000,
  ): Promise<unknown> {
    return await connection.request(payload as never, timeout);
  }
});

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`));
    });
  });
}
