/** The parts of node-pty that Shepherd reaches past the public API for.
 *
 * node-pty comes from @lydell/node-pty: the upstream package split into one
 * prebuilt package per platform and installed through optionalDependencies.
 * Nothing is compiled and no install script runs, so installs work under
 * npm 12's script blocking, pnpm and Bun, and on Windows without Visual
 * Studio or Python. */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import pty from "@lydell/node-pty";

const nodeRequire = createRequire(import.meta.url);
const PLATFORM = `${process.platform}-${process.arch}`;

export interface PtyBinding {
  resize(fd: number, cols: number, rows: number, pixelWidth: number, pixelHeight: number): void;
}

/** node-pty's Unix native module. Upstream exports it as `native` (marked
 * unofficial), which avoids hardcoding where the prebuilt .node file lives. */
export function ptyBinding(): PtyBinding {
  const binding = (pty as unknown as { native?: PtyBinding | null }).native;
  if (!binding) throw new Error(`node-pty native module is unavailable on ${PLATFORM}`);
  return binding;
}

/** Directory holding the prebuilt pty.node (and spawn-helper on macOS).
 * Resolved from the wrapper package so strict layouts like pnpm work. */
function prebuildDirectory(): string | null {
  try {
    const wrapper = createRequire(nodeRequire.resolve("@lydell/node-pty"));
    const entry = wrapper.resolve(`@lydell/node-pty-${PLATFORM}`);
    return path.join(path.dirname(entry), "..", "prebuilds", PLATFORM);
  } catch {
    return null;
  }
}

let spawnHelperChecked = false;

/** npm can unpack macOS's spawn-helper without its execute bit, which makes
 * every spawn fail with "posix_spawnp failed". Restore it when possible. */
export function repairSpawnHelper(): void {
  if (spawnHelperChecked || process.platform !== "darwin") return;
  spawnHelperChecked = true;
  const directory = prebuildDirectory();
  if (!directory) return;
  const helper = path.join(directory, "spawn-helper");
  try {
    const { mode } = fs.statSync(helper);
    if ((mode & 0o111) !== 0o111) fs.chmodSync(helper, mode | 0o755);
  } catch {
    // Missing, or read-only (a root-owned global install); spawn reports it.
  }
}
