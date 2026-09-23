import { execFile } from "node:child_process";
import path from "node:path";

export interface ProcessEntry {
  pid: number;
  ppid: number;
  pgid: number;
  /** Foreground process group of the process's controlling terminal. */
  tpgid: number;
  args: string;
}

/** One snapshot of the process table (`ps`), shared by every pane. */
export function processTable(): Promise<ProcessEntry[]> {
  if (process.platform === "win32") return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,pgid=,tpgid=,args="],
      { maxBuffer: 16 * 1024 * 1024, timeout: 2_000 },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        resolve(parseProcessTable(stdout));
      },
    );
  });
}

export function parseProcessTable(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      tpgid: Number(match[4]),
      args: match[5] ?? "",
    });
  }
  return entries;
}

/** The foreground job of the terminal a shell runs on: the leader of its
 * foreground process group (or the oldest member), or null when the shell
 * itself is in the foreground. */
export function foregroundProcess(
  table: ProcessEntry[],
  shellPid: number,
): ProcessEntry | null {
  const shell = table.find((entry) => entry.pid === shellPid);
  if (!shell || shell.tpgid <= 0 || shell.tpgid === shell.pgid) return null;
  const group = table.filter((entry) => entry.pgid === shell.tpgid);
  if (group.length === 0) return null;
  return group.find((entry) => entry.pid === entry.pgid) ??
    [...group].sort((left, right) => left.pid - right.pid)[0] ??
    null;
}

const WRAPPERS = new Set([
  "node",
  "nodejs",
  "bun",
  "deno",
  "python",
  "python3",
  "uv",
  "uvx",
  "npx",
  "pnpx",
  "bunx",
  "env",
  "nix",
  "sh",
  "bash",
  "zsh",
]);

/** A command line with interpreter wrappers removed, so that
 * `node /usr/local/bin/claude --resume` reads as `claude --resume`. */
export function unwrapCommand(args: string): string {
  const parts = args.trim().split(/\s+/);
  let index = 0;
  while (index < parts.length - 1) {
    const base = path.basename(parts[index] ?? "").replace(/\d+(\.\d+)*$/, "");
    if (!WRAPPERS.has(base) && !WRAPPERS.has(path.basename(parts[index] ?? ""))) break;
    index += 1;
    // Skip interpreter flags such as `node --no-warnings` or `python -m`.
    while (index < parts.length - 1 && (parts[index] ?? "").startsWith("-")) {
      const flag = parts[index];
      index += 1;
      if (flag === "-m" || flag === "-c") break;
    }
  }
  return parts.slice(index).join(" ");
}
