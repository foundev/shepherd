/** Running Shepherd on the far side of ssh: finding the executable,
 * explaining how to install it, and composing remote command lines. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { machinesDirectory, sshTarget, type SavedMachine } from "../machines.js";
import {
  shellQuote,
  sshInvocation,
  type SshEndpoint,
  type SshOptions,
} from "./ssh.js";

export const DEFAULT_BRIDGE_IDLE_MS = 60_000;

/** Looks for `shepherd` on the remote PATH, then in common install
 * directories a non-interactive ssh shell may leave off PATH. Runs under
 * `sh -c` so it also works when the login shell is not POSIX. */
const DISCOVERY_SCRIPT = [
  "p=$(command -v shepherd 2>/dev/null)",
  'if [ -z "$p" ]; then for c in "$HOME/.local/bin/shepherd" "$HOME/.npm-global/bin/shepherd" "$HOME/.volta/bin/shepherd" "$HOME/.bun/bin/shepherd" /opt/homebrew/bin/shepherd /usr/local/bin/shepherd "$HOME"/.nvm/versions/node/*/bin/shepherd; do if [ -x "$c" ]; then p="$c"; break; fi; done; fi',
  'if [ -n "$p" ]; then echo "SHEPHERD_PATH=$p"; else echo SHEPHERD_MISSING; fi',
].join("; ");

export function discoveryCommand(): string {
  return `sh -c ${shellQuote(DISCOVERY_SCRIPT)}`;
}

export type Discovery =
  | { status: "found"; path: string }
  | { status: "missing" }
  | { status: "ssh-error"; message: string; attention: boolean };

export function parseDiscovery(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): Discovery {
  const found = /^SHEPHERD_PATH=(.+)$/m.exec(stdout);
  if (found?.[1]) return { status: "found", path: found[1].trim() };
  if (/^SHEPHERD_MISSING$/m.test(stdout)) return { status: "missing" };
  const message = lastLine(stderr) ||
    `ssh exited ${exitCode ?? "without status"}`;
  return { status: "ssh-error", message, attention: needsAttention(stderr) };
}

/** ssh failures a background retry cannot fix: the user has to approve a
 * host key, load a key, or fix authentication. */
export function needsAttention(stderr: string): boolean {
  return /permission denied|host key verification failed|remote host identification has changed|no more authentication methods|too many authentication failures|passphrase|password:/i
    .test(stderr);
}

export async function discoverRemoteShepherd(
  endpoint: SshEndpoint,
  options: SshOptions,
  timeoutMs = 30_000,
): Promise<Discovery> {
  const { command, args } = sshInvocation(endpoint, discoveryCommand(), {
    ...options,
    tty: "disable",
  });
  try {
    const result = await runProcess(command, args, timeoutMs);
    return parseDiscovery(result.stdout, result.stderr, result.exitCode);
  } catch (error) {
    return {
      status: "ssh-error",
      message: error instanceof Error ? error.message : String(error),
      attention: false,
    };
  }
}

export function installInstructions(endpoint: SshEndpoint): string {
  const target = sshTarget(endpoint);
  const sshCommand = endpoint.port !== null && endpoint.port !== 22
    ? `ssh -p ${endpoint.port} ${target}`
    : `ssh ${target}`;
  return [
    `shepherd was not found on ${target}.`,
    "",
    "Install Shepherd on the remote machine (Node 22 or newer), then retry:",
    "",
    `  ${sshCommand}`,
    "  git clone https://github.com/foundev/shepherd.git ~/shepherd",
    "  cd ~/shepherd && npm install && npm run build && npm link",
    "",
    "Make sure `shepherd` is on the PATH of non-interactive ssh sessions",
    "(for example ~/.local/bin or /usr/local/bin). Shepherd does not copy",
    "binaries to remote hosts.",
  ].join("\n");
}

/** `<shepherd> [--session NAME] server bridge --idle-timeout MS` */
export function bridgeCommand(
  executable: string,
  session: string | null,
  idleTimeoutMs = DEFAULT_BRIDGE_IDLE_MS,
): string {
  return [
    executable,
    ...(session && session !== "default" ? ["--session", session] : []),
    "server",
    "bridge",
    "--idle-timeout",
    String(idleTimeoutMs),
  ].map(shellQuote).join(" ");
}

/** `<shepherd> [--session NAME] <args...>` */
export function shepherdCommand(
  executable: string,
  session: string | null,
  args: string[],
): string {
  return [
    executable,
    ...(session && session !== "default" ? ["--session", session] : []),
    ...args,
  ].map(shellQuote).join(" ");
}

/** Runs a command to completion, capturing output. Resolves on exit rather
 * than on stdio close: a backgrounded ControlMaster may hold the pipes. */
export function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`ssh timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const done = () => resolve({ stdout, stderr, exitCode });
      if (child.stdout?.readableEnded !== false && child.stderr?.readableEnded !== false) {
        done();
        return;
      }
      let pending = 2;
      const grace = setTimeout(done, 200);
      const ended = () => {
        pending -= 1;
        if (pending === 0) {
          clearTimeout(grace);
          done();
        }
      };
      if (child.stdout?.readableEnded === false) child.stdout.once("end", ended);
      else ended();
      if (child.stderr?.readableEnded === false) child.stderr.once("end", ended);
      else ended();
    });
  });
}

export type MachineRunResult =
  | { status: "ran"; exitCode: number; stdout: string; stderr: string }
  | { status: "missing"; message: string }
  | { status: "unreachable"; message: string };

/** Runs `shepherd <args>` on a saved machine over the shared ControlMaster.
 * Uses the cached executable path when there is one; if that path no
 * longer exists (exit 127, so nothing ran) it rediscovers once. */
export async function runShepherdOnMachine(
  machine: SavedMachine,
  args: string[],
  options: { manage: boolean; capture: boolean; timeoutMs?: number },
): Promise<MachineRunResult> {
  const endpoint: SshEndpoint = { user: machine.user, host: machine.host, port: machine.port };
  const ssh: SshOptions = {
    manage: options.manage,
    control: "shared",
    batch: !process.stdin.isTTY,
  };
  const attempt = async (executable: string) => {
    const invocation = sshInvocation(
      endpoint,
      shepherdCommand(executable, machine.remoteSession ?? null, args),
      { ...ssh, tty: "disable" },
    );
    if (options.capture) {
      const result = await runProcess(invocation.command, invocation.args, options.timeoutMs ?? 60_000);
      return { ...result, exitCode: result.exitCode ?? 1 };
    }
    const child = spawn(invocation.command, invocation.args, { stdio: "inherit" });
    const exitCode = await new Promise<number>((resolve) => {
      child.once("error", () => resolve(127));
      child.once("exit", (code) => resolve(code ?? 1));
    });
    return { stdout: "", stderr: "", exitCode };
  };
  let executable = cachedExecutable(machine.id);
  let fromCache = executable !== null;
  for (;;) {
    if (!executable) {
      const discovery = await discoverRemoteShepherd(endpoint, ssh);
      if (discovery.status === "missing") {
        return { status: "missing", message: installInstructions(endpoint) };
      }
      if (discovery.status === "ssh-error") {
        return { status: "unreachable", message: discovery.message };
      }
      executable = discovery.path;
      rememberExecutable(machine.id, executable);
    }
    const result = await attempt(executable);
    if (result.exitCode === 127 && fromCache) {
      rememberExecutable(machine.id, null);
      executable = null;
      fromCache = false;
      continue;
    }
    return { status: "ran", ...result };
  }
}

/** Remembered remote executable paths by machine ID, so repeated
 * `machine exec` commands skip discovery. Purely an optimization: a missing
 * or unreadable cache only costs one extra round trip. */
function cachePath(): string {
  return path.join(machinesDirectory(), "machine-cache.json");
}

export function cachedExecutable(machineId: string): string | null {
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath(), "utf8")) as Record<string, { executable?: unknown }>;
    const value = cache[machineId]?.executable;
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

export function rememberExecutable(machineId: string, executable: string | null): void {
  try {
    let cache: Record<string, { executable?: string }> = {};
    try {
      cache = JSON.parse(fs.readFileSync(cachePath(), "utf8")) as typeof cache;
    } catch {
      cache = {};
    }
    if (executable) cache[machineId] = { executable };
    else delete cache[machineId];
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    const temporary = `${cachePath()}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, cachePath());
  } catch {
    // Unwritable cache: discovery simply runs next time.
  }
}

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}
