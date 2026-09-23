import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskChanges } from "../types.js";

const execute = promisify(execFile);
/** Read-only checkout changes, not attribution to a particular agent. */
export async function taskChanges(cwd: string): Promise<TaskChanges | null> {
  let stdout: string;
  try {
    ({ stdout } = await execute("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=normal"], {
      cwd, timeout: 5000, maxBuffer: 512 * 1024, encoding: "utf8",
    }));
  } catch (error) {
    if (/not a git repository/i.test(String((error as { stderr?: string }).stderr))) return null;
    throw new Error("Could not read checkout changes within the time or output limit");
  }
  return parseTaskChanges(stdout);
}

export function parseTaskChanges(output: string): TaskChanges {
  const records = output.split("\0");
  const files: TaskChanges["files"] = [];
  let total = 0;
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const from = /[RC]/.test(status) ? records[++i] : undefined;
    total++;
    if (files.length < 200) files.push({ path: record.slice(3), status, ...(from ? { from } : {}) });
  }
  return { files, total };
}
