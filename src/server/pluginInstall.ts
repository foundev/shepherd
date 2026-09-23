import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadPluginManifest, type PluginManifest } from "./plugins.js";

export interface GithubPluginSource {
  owner: string;
  repo: string;
  subdir: string | null;
}

export function parseGithubPluginSource(
  value: string,
): GithubPluginSource {
  if (
    value.includes("://") ||
    value.includes(":") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error(
      "plugin install accepts only owner/repo[/subdir] GitHub shorthand",
    );
  }
  const parts = value.split("/");
  if (parts.length < 2) {
    throw new Error("usage: plugin install <owner>/<repo>[/subdir]");
  }
  const [owner, repo, ...subdir] = parts;
  validateSegment("owner", owner);
  validateSegment("repository", repo);
  for (const segment of subdir) validateSegment("subdirectory", segment);
  return {
    owner,
    repo,
    subdir: subdir.length ? subdir.join("/") : null,
  };
}

export async function checkoutGithubPlugin(
  source: GithubPluginSource,
  reference: string | undefined,
  checkoutPath: string,
): Promise<string> {
  fs.mkdirSync(checkoutPath, { recursive: true });
  await runGit(checkoutPath, ["init"]);
  await runGit(checkoutPath, [
    "remote",
    "add",
    "origin",
    remoteUrl(source),
  ]);
  await runGit(checkoutPath, [
    "fetch",
    "--depth",
    "1",
    "origin",
    reference ?? "HEAD",
  ]);
  await runGit(checkoutPath, ["checkout", "--detach", "FETCH_HEAD"]);
  return gitOutput(checkoutPath, ["rev-parse", "HEAD"]);
}

export function pluginManifestRoot(
  checkoutPath: string,
  source: GithubPluginSource,
): string {
  return source.subdir
    ? path.join(checkoutPath, source.subdir)
    : checkoutPath;
}

export function managedPluginPath(
  stateDirectory: string,
  source: GithubPluginSource,
): string {
  const suffix = source.subdir
    ? `-${source.subdir.replace(/[^a-zA-Z0-9_-]+/g, "-")}`
    : "";
  return path.join(
    stateDirectory,
    "managed-plugins",
    `${source.owner}-${source.repo}${suffix}`,
  );
}

export function replaceManagedPlugin(
  checkoutPath: string,
  managedPath: string,
): void {
  const backup = `${managedPath}.previous`;
  fs.rmSync(backup, { recursive: true, force: true });
  if (fs.existsSync(managedPath)) {
    fs.renameSync(managedPath, backup);
  }
  try {
    fs.mkdirSync(path.dirname(managedPath), { recursive: true });
    fs.renameSync(checkoutPath, managedPath);
  } catch (error) {
    if (fs.existsSync(backup)) fs.renameSync(backup, managedPath);
    throw error;
  }
  fs.rmSync(backup, { recursive: true, force: true });
}

export function reloadManifestAfterBuild(
  root: string,
  before: PluginManifest,
): PluginManifest {
  const after = loadPluginManifest(root);
  // Builds may generate files, but not change what the user confirmed.
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error("plugin manifest changed during build");
  }
  return after;
}

/** Whether `root` lies inside the session's managed plugin directory. */
export function isManagedPluginRoot(stateDirectory: string, root: string): boolean {
  const managedRoot = path.resolve(stateDirectory, "managed-plugins");
  const relative = path.relative(managedRoot, path.resolve(root));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** The managed checkout that holds `root` (a manifest root may be a
 * subdirectory of the checkout). */
export function managedCheckoutFor(stateDirectory: string, root: string): string | null {
  if (!isManagedPluginRoot(stateDirectory, root)) return null;
  const managedRoot = path.resolve(stateDirectory, "managed-plugins");
  const [first] = path.relative(managedRoot, path.resolve(root)).split(path.sep);
  return first ? path.join(managedRoot, first) : null;
}

function remoteUrl(source: GithubPluginSource): string {
  return `https://github.com/${source.owner}/${source.repo}.git`;
}

function validateSegment(label: string, value: string | undefined): void {
  if (!value || value === "." || value === "..") {
    throw new Error(`invalid GitHub ${label}`);
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(value)) {
    throw new Error(`invalid GitHub ${label}: ${value}`);
  }
}

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new Error(`git ${args[0] ?? ""} failed: ${stderr.trim()}`));
    });
  });
}

function gitOutput(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
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
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args[0] ?? ""} failed: ${stderr.trim()}`));
    });
  });
}
