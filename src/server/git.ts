import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface GitWorktree {
  path: string;
  branch: string | null;
  commit: string;
  bare: boolean;
  detached: boolean;
}

export async function gitOutput(
  cwd: string,
  args: string[],
): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() ||
        `git ${args[0] ?? ""} exited ${result.exitCode ?? "without status"}`,
    );
  }
  return result.stdout;
}

/** Branch and upstream divergence for the repository containing `cwd`,
 * or null when it is not in a Git repository. */
export async function gitStatus(cwd: string): Promise<{
  repoName: string;
  /** Identifies the repository across its worktrees (the common dir). */
  repoKey: string;
  /** Root of the main worktree. */
  repoRoot: string;
  /** True for a linked worktree (not the main checkout). */
  linked: boolean;
  checkoutPath: string;
  branch: string | null;
  ahead: number;
  behind: number;
} | null> {
  const top = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.exitCode !== 0) return null;
  const root = top.stdout.trim();
  const dirs = await runGit(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
  ]);
  const [gitDir, commonDir] = dirs.exitCode === 0
    ? dirs.stdout.trim().split("\n")
    : [undefined, undefined];
  const repoKey = realpath(commonDir ?? path.join(root, ".git"));
  const linked = Boolean(gitDir && commonDir && realpath(gitDir) !== repoKey);
  const repoRoot = path.basename(repoKey) === ".git" ? path.dirname(repoKey) : root;
  const head = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = head.exitCode === 0 && head.stdout.trim() !== "HEAD"
    ? head.stdout.trim()
    : null;
  let ahead = 0;
  let behind = 0;
  const counts = await runGit(cwd, [
    "rev-list",
    "--left-right",
    "--count",
    "@{upstream}...HEAD",
  ]);
  if (counts.exitCode === 0) {
    const [left, right] = counts.stdout.trim().split(/\s+/).map(Number);
    behind = Number.isFinite(left) ? left ?? 0 : 0;
    ahead = Number.isFinite(right) ? right ?? 0 : 0;
  }
  return {
    repoName: path.basename(repoRoot),
    repoKey,
    repoRoot,
    linked,
    checkoutPath: root,
    branch,
    ahead,
    behind,
  };
}

function realpath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

/** Branch name → directory name, as Shepherd's worktree paths use. */
export function branchSlug(branch: string): string {
  return branch
    .replace(/^refs\/heads\//, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "worktree";
}

export async function branchExists(root: string, branch: string): Promise<boolean> {
  const result = await runGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return result.exitCode === 0;
}

export async function discoverRepository(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) throw new Error(`path does not exist: ${resolved}`);
  const root = (await gitOutput(resolved, [
    "rev-parse",
    "--show-toplevel",
  ])).trim();
  if (!root) throw new Error(`not a Git repository: ${resolved}`);
  return root;
}

export async function listWorktrees(root: string): Promise<GitWorktree[]> {
  const output = await gitOutput(root, [
    "worktree",
    "list",
    "--porcelain",
  ]);
  const records: GitWorktree[] = [];
  let current: Partial<GitWorktree> | null = null;
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") {
      if (current?.path) records.push(normalizeWorktree(current));
      current = { path: value };
    } else if (key === "HEAD" && current) {
      current.commit = value;
    } else if (key === "branch" && current) {
      current.branch = value.replace(/^refs\/heads\//, "");
    } else if (key === "bare" && current) {
      current.bare = true;
    } else if (key === "detached" && current) {
      current.detached = true;
    }
  }
  if (current?.path) records.push(normalizeWorktree(current));
  return records;
}

export async function createWorktree(options: {
  root: string;
  path: string;
  branch: string;
  createBranch: boolean;
  startPoint?: string;
}): Promise<void> {
  const target = path.resolve(options.path);
  if (target === path.resolve(options.root)) {
    throw new Error("worktree path must differ from repository root");
  }
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(target)) throw new Error(`path already exists: ${target}`);
  const args = ["worktree", "add"];
  if (options.createBranch) args.push("-b", options.branch);
  else args.push(options.branch);
  args.push(target);
  if (options.startPoint) args.push(options.startPoint);
  await gitOutput(options.root, args);
}

export async function removeWorktree(
  root: string,
  target: string,
  force: boolean,
): Promise<void> {
  const resolved = path.resolve(target);
  const known = await listWorktrees(root);
  if (!known.some((worktree) => worktree.path === resolved)) {
    throw new Error(`unknown worktree: ${resolved}`);
  }
  await gitOutput(root, [
    "worktree",
    "remove",
    ...(force ? ["--force"] : []),
    resolved,
  ]);
}

function normalizeWorktree(value: Partial<GitWorktree>): GitWorktree {
  if (!value.path || !value.commit) {
    throw new Error("Git returned an incomplete worktree record");
  }
  return {
    path: value.path,
    commit: value.commit,
    branch: value.branch ?? null,
    bare: value.bare ?? false,
    detached: value.detached ?? false,
  };
}

function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({
        stdout,
        stderr: `${stderr}${error.message}`,
        exitCode: 127,
      });
    });
    child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
}
