import net from "node:net";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function socketPath(session = "default"): string {
  const override = process.env.SHEPHERD_SOCKET_PATH;
  if (override) return override;
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

export function connect(
  pathName: string,
  timeoutMs = 1_500,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: pathName });
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
