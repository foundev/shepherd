/** A POSIX shell for integration tests whose pane commands are shell
 * scripts. Unix panes already run one; on Windows the pane shell defaults
 * to cmd.exe, so these tests use Git for Windows' bash instead. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function findGitBash(): string | null {
  const candidates: string[] = [];
  try {
    // e.g. C:/Program Files/Git/mingw64/libexec/git-core
    const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
    candidates.push(path.join(execPath, "..", "..", "..", "bin", "bash.exe"));
  } catch {
    // git is not on PATH; try the default install location.
  }
  for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    if (base) candidates.push(path.join(base, "Git", "bin", "bash.exe"));
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** Git Bash on Windows; null elsewhere or when it is not installed. Not
 * `where bash`, which can find WSL's launcher in System32. */
export const windowsBash = process.platform === "win32" ? findGitBash() : null;

/** Starting and reaping a pane process takes over a second on Windows
 * (Git Bash startup, and node-pty's ConPTY exit check), so waits for pane
 * processes and the tests making them get longer there. */
export const paneWaitMs = process.platform === "win32" ? 15_000 : 4_000;
export const paneTestTimeout = process.platform === "win32" ? 30_000 : 5_000;

/** True on Windows without Git Bash: tests that need a POSIX shell skip. */
export const missingPosixShell = process.platform === "win32" && windowsBash === null;

/** The `shell` option for a PaneTerminal: Git Bash on Windows, otherwise
 * undefined to keep the platform default. */
export const testPaneShell = windowsBash ? { file: windowsBash, args: [] } : undefined;

/** A TOML `default_shell` value: `unixShell` on Unix, Git Bash on Windows. */
export function defaultShellToml(unixShell: string): string {
  return JSON.stringify(windowsBash ?? unixShell);
}

/** A config.toml `[terminal]` table selecting Git Bash on Windows; empty
 * elsewhere, so Unix keeps the user's shell. */
export function windowsShellConfig(): string {
  return windowsBash ? `[terminal]\ndefault_shell = ${JSON.stringify(windowsBash)}\n` : "";
}
