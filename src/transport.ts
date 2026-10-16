import net from "node:net";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function socketPath(session = "default"): string {
  const override = process.env.SHEPHERD_SOCKET_PATH;
  if (override) return override;
  return defaultSocketPath(session);
}

/** A session's daemon address, ignoring SHEPHERD_SOCKET_PATH. */
export function defaultSocketPath(session: string): string {
  if (process.platform === "win32") {
    const user = os.userInfo().username.replace(/[^a-zA-Z0-9]/g, "-");
    return `\\\\.\\pipe\\shepherd-${user}-${session}`;
  }
  return path.join(
    os.homedir(),
    ".local",
    "state",
    "shepherd",
    session,
    "daemon.sock",
  );
}

const PIPE_PREFIX = "\\\\.\\pipe\\";

/** The address to listen on or connect to for a socket path. Windows has no
 * Unix domain sockets on the filesystem, so a file path such as
 * `<state>/daemon.sock` maps to a named pipe derived from that path; both
 * sides of a connection reach the same pipe through this function. */
export function ipcPath(pathName: string, platform = process.platform): string {
  if (platform !== "win32" || pathName.startsWith(PIPE_PREFIX)) return pathName;
  const resolved = path.win32.resolve(pathName).toLowerCase();
  const digest = createHash("sha256").update(resolved).digest("hex").slice(0, 32);
  return `${PIPE_PREFIX}shepherd-${digest}`;
}

/** Whether a socket path is a filesystem entry that can be stat'ed or unlinked. */
export function isFilesystemSocket(pathName: string, platform = process.platform): boolean {
  return ipcPath(pathName, platform) === pathName && !pathName.startsWith(PIPE_PREFIX);
}

export function connect(
  pathName: string,
  timeoutMs = 1_500,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: ipcPath(pathName) });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out connecting to ${pathName}`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}

export async function ensureDaemon(
  session = "default",
): Promise<net.Socket> {
  const pathName = socketPath(session);
  try {
    return await connect(pathName);
  } catch (error) {
    if (!isStartupError(error)) throw error;
  }

  if (process.platform !== "win32") {
    try {
      fs.unlinkSync(pathName);
    } catch {
      // The socket either does not exist or another daemon is replacing it.
    }
  }

  startDaemon(session);
  const deadline = Date.now() + 10_000;
  let lastError: unknown = new Error("daemon did not start");
  while (Date.now() < deadline) {
    await sleep(100);
    try {
      return await connect(pathName, 500);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function startDaemon(session: string): void {
  const entry = process.argv[1]
    ? path.resolve(process.argv[1] ?? "")
    : fileURLToPath(import.meta.url);
  const isTypeScript = entry.endsWith(".ts");
  const args = isTypeScript
    ? ["--import", "tsx", entry, "server", "start", "--foreground"]
    : [entry, "server", "start", "--foreground"];

  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      SHEPHERD_SOCKET_PATH: socketPath(session),
    },
  });
  child.unref();
}

function isStartupError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return (
    code === "ECONNREFUSED" ||
    code === "ENOENT" ||
    code === "ENOTSOCK" ||
    code === "ETIMEDOUT"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
