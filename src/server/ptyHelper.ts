/** node-pty spawns every Unix PTY through its `spawn-helper` binary. The
 * macOS prebuilds in node-pty 1.1.0 are published without the execute bit,
 * so every spawn fails with "posix_spawnp failed" until it is restored. */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const nodeRequire = createRequire(import.meta.url);

export function ensureSpawnHelperExecutable(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): void {
  if (platform === "win32") return;
  let root: string;
  try {
    root = path.dirname(nodeRequire.resolve("node-pty/package.json"));
  } catch {
    return;
  }
  for (const directory of ["build/Release", "build/Debug", `prebuilds/${platform}-${arch}`]) {
    const helper = path.join(root, directory, "spawn-helper");
    try {
      const mode = fs.statSync(helper).mode;
      if ((mode & 0o111) !== 0o111) fs.chmodSync(helper, mode | 0o755);
    } catch {
      // Missing, or an install we cannot write to; spawning reports the error.
    }
  }
}
