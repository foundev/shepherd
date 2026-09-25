import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientConnection } from "../src/client/connection.js";
import { ShepherdDaemon } from "../src/server/daemon.js";
import { saveState } from "../src/server/persistence.js";
import { connect } from "../src/transport.js";
import type { ShepherdRequest, StateView } from "../src/types.js";

describe("workspace directory identity", () => {
  let directory: string;
  let initialCwd: string;
  let repository: string;
  let nested: string;
  let outside: string;
  let socketPath: string;
  let daemon: ShepherdDaemon;
  let connection: ClientConnection;

  beforeEach(async () => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-spaces-")));
    initialCwd = path.join(directory, "starting-folder");
    repository = path.join(directory, "project");
    nested = path.join(repository, "src");
    outside = path.join(directory, "other folder");
    for (const cwd of [initialCwd, nested, outside]) fs.mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "-b", "main", repository], { stdio: "ignore" });
    execFileSync("git", ["-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial"], { stdio: "ignore" });
    socketPath = path.join(directory, "daemon.sock");
    vi.stubEnv("SHEPHERD_STATE_HOME", directory);
    vi.stubEnv("SHEPHERD_CONFIG_PATH", path.join(directory, "config.toml"));
    fs.writeFileSync(process.env.SHEPHERD_CONFIG_PATH!, '[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n');
    // Also exercises restoring older sessions without a saved rootPaneId.
    saveState("spaces", {
      version: 2,
      activeWorkspaceId: "w1",
      workspaces: [{ id: "w1", name: "", rootPath: initialCwd, activeTabId: "t1",
        tabs: [{ id: "t1", name: "", layout: { kind: "pane", paneId: "p1" }, focusedPaneId: "p1" }],
      }],
      panes: [{ id: "p1", title: "", command: null, cwd: initialCwd }],
    });
    await start();
  });

  afterEach(async () => {
    connection?.close();
    await daemon?.stop();
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function start(): Promise<void> {
    daemon = new ShepherdDaemon({ session: "spaces", socketPath });
    await daemon.start();
    connection = ClientConnection.open(await connect(socketPath));
  }

  async function request(message: ShepherdRequest): Promise<StateView> {
    return await connection.request(message) as StateView;
  }

  async function cd(paneId: string, cwd: string): Promise<void> {
    await request({ type: "pane.input", paneId, data: `cd '${cwd.replaceAll("'", "'\\''")}'\r` });
    await expect.poll(async () => (await request({ type: "state.get" })).panes.find((pane) => pane.id === paneId)?.cwd,
      { timeout: 5_000 }).toBe(cwd);
  }

  async function workspace(id = "w1") {
    return (await request({ type: "state.get" })).workspaces.find((entry) => entry.id === id)!;
  }

  it("follows cd without shell integration, including a newly created space and leaving Git", async () => {
    await cd("p1", nested);
    await expect.poll(async () => (await workspace()).label).toBe("project");
    expect(await workspace()).toMatchObject({ name: "", rootPath: nested, git: { branch: "main", checkoutPath: repository } });

    const created = await request({ type: "workspace.create" });
    const id = created.activeWorkspaceId;
    expect(await workspace(id)).toMatchObject({ name: "", rootPath: nested });
    await cd(created.focusedPaneId, outside);
    expect(await workspace(id)).toMatchObject({ label: "other folder", rootPath: outside, git: null });
    expect(await workspace()).toMatchObject({ label: "project", rootPath: nested });
  });

  it("preserves custom names and resumes automatic naming when cleared", async () => {
    await request({ type: "workspace.rename", workspaceId: "w1", name: "research" });
    await cd("p1", nested);
    await expect.poll(async () => (await workspace()).git?.branch).toBe("main");
    expect(await workspace()).toMatchObject({ name: "research", label: "research", rootPath: nested });
    await request({ type: "workspace.rename", workspaceId: "w1", name: "" });
    expect(await workspace()).toMatchObject({ name: "", label: "project" });
  });

  it("keeps the root pane through focus, swaps, and restore, then adopts a surviving pane", async () => {
    await cd("p1", nested);
    const split = await request({ type: "pane.create", direction: "right" });
    const otherPane = split.focusedPaneId;
    await cd(otherPane, outside);
    await request({ type: "pane.swap", paneId: "p1", targetPaneId: otherPane });
    await expect.poll(async () => (await workspace()).label).toBe("project");
    expect((await workspace()).rootPath).toBe(nested);

    connection.close();
    await daemon.stop();
    await start();
    await expect.poll(async () => (await workspace()).label).toBe("project");
    expect((await workspace()).rootPath).toBe(nested);
    await request({ type: "pane.close", paneId: "p1" });
    expect(await workspace()).toMatchObject({ label: "other folder", rootPath: outside, git: null });
  });

  it("uses the first tab independently of clients' selected tabs and replaces it when closed", async () => {
    await cd("p1", nested);
    const second = ClientConnection.open(await connect(socketPath));
    try {
      await second.request({ type: "state.get" });
      const tab = await request({ type: "tab.create" });
      await cd(tab.focusedPaneId, outside);
      await expect.poll(async () => (await workspace()).label).toBe("project");
      const otherState = await second.request({ type: "state.get" }) as StateView;
      expect(otherState.activeTabId).toBe("t1");
      expect(otherState.workspaces[0]).toMatchObject({ label: "project", rootPath: nested });
      await request({ type: "tab.close", tabId: "t1" });
      expect(await workspace()).toMatchObject({ label: "other folder", rootPath: outside, git: null });
    } finally { second.close(); }
  });

  it("honors OSC 7 even when the process directory differs", async () => {
    await request({ type: "pane.input", paneId: "p1", data: `printf '\\033]7;%s\\007' '${pathToFileURL(outside).href}'\r` });
    await expect.poll(async () => (await workspace()).rootPath).toBe(outside);
    // A subsequent process poll must not overwrite the shell's report.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await workspace()).toMatchObject({ label: "other folder", rootPath: outside });
    const created = await request({ type: "tab.create" });
    expect(created.panes.find((pane) => pane.id === created.focusedPaneId)?.cwd).toBe(outside);
  });

  it("uses a linked checkout's name without making it a permanent custom name", async () => {
    const checkout = path.join(directory, "feature-checkout");
    execFileSync("git", ["-C", repository, "worktree", "add", "-b", "feature", checkout], { stdio: "ignore" });
    const opened = await request({ type: "worktree.open", path: checkout });
    const id = opened.activeWorkspaceId;
    await expect.poll(async () => (await workspace(id)).git?.linked).toBe(true);
    expect(await workspace(id)).toMatchObject({ name: "", label: "feature-checkout", git: { repoName: "project", branch: "feature" } });
    const subdirectory = path.join(checkout, "subdir");
    fs.mkdirSync(subdirectory);
    await cd(opened.focusedPaneId, subdirectory);
    const worktrees = await connection.request({ type: "worktree.list", root: repository }) as Array<{ path: string; openWorkspaceId: string | null }>;
    expect(worktrees.find((worktree) => worktree.path === checkout)?.openWorkspaceId).toBe(id);
    await expect(connection.request({ type: "worktree.remove", root: repository, path: checkout })).rejects.toThrow("close workspace");
    await cd(opened.focusedPaneId, outside);
    expect(await workspace(id)).toMatchObject({ name: "", label: "other folder", git: null });
  });
}, 10_000);
