/** A pretend remote host for integration tests: a fake `ssh` that skips its
 * options and destination and runs the remote command locally, in an
 * environment (HOME, PATH, socket, state and config directories) that
 * stands in for the other machine. Its `shepherd` is this checkout. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect } from "../src/transport.js";
import { ClientConnection } from "../src/client/connection.js";

export interface RemoteFixture {
  root: string;
  /** Directory holding the fake `ssh`; put it first on PATH. */
  sshBin: string;
  /** Every fake ssh invocation's arguments, one line each. */
  sshLog: string;
  remoteSocket: string;
  runtimeDir: string;
  sshLines(): string[];
  stopRemoteDaemon(): Promise<void>;
  cleanup(): void;
}

/** Targets whose host contains "bare" behave like a machine without
 * Shepherd installed. */
export function createRemoteFixture(): RemoteFixture {
  // Short root: the remote daemon socket must fit in sun_path.
  const root = fs.mkdtempSync(path.join(os.platform() === "darwin" ? "/tmp" : os.tmpdir(), "shr-"));
  const sshBin = path.join(root, "sshbin");
  const remoteBin = path.join(root, "rbin");
  const bareBin = path.join(root, "bare");
  const remoteHome = path.join(root, "home");
  const remoteSocket = path.join(root, "r.sock");
  const runtimeDir = path.join(root, "rt");
  const sshLog = path.join(root, "ssh.log");
  for (const directory of [sshBin, remoteBin, bareBin, remoteHome]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const repo = process.cwd();
  fs.writeFileSync(path.join(remoteBin, "shepherd"), [
    "#!/bin/sh",
    `cd ${JSON.stringify(repo)} || exit 1`,
    `exec ${JSON.stringify(process.execPath)} --import tsx ${JSON.stringify(path.join(repo, "src", "cli.ts"))} "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  fs.writeFileSync(path.join(sshBin, "ssh"), [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${JSON.stringify(sshLog)}`,
    'while [ $# -gt 0 ]; do',
    '  if [ "$1" = "--" ]; then shift; break; fi',
    "  shift",
    "done",
    'target="$1"',
    '[ $# -gt 0 ] && shift',
    '[ $# -eq 0 ] && exit 0',
    'case "$target" in',
    `  *bare*) bin=${JSON.stringify(bareBin)} ;;`,
    `  *) bin=${JSON.stringify(remoteBin)} ;;`,
    "esac",
    `HOME=${JSON.stringify(remoteHome)} \\`,
    `SHEPHERD_SOCKET_PATH=${JSON.stringify(remoteSocket)} \\`,
    `SHEPHERD_STATE_HOME=${JSON.stringify(path.join(root, "rstate"))} \\`,
    `SHEPHERD_CONFIG_HOME=${JSON.stringify(path.join(root, "rconfig"))} \\`,
    "SHEPHERD_CONFIG_PATH= XDG_CONFIG_HOME= \\",
    'PATH="$bin:/usr/bin:/bin" \\',
    'exec /bin/sh -c "$1"',
    "",
  ].join("\n"), { mode: 0o755 });
  return {
    root,
    sshBin,
    sshLog,
    remoteSocket,
    runtimeDir,
    sshLines: () => {
      try {
        return fs.readFileSync(sshLog, "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    stopRemoteDaemon: async () => {
      try {
        const socket = await connect(remoteSocket, 500);
        const connection = ClientConnection.open(socket);
        await connection.request({ type: "server.stop" }, 2_000).catch(() => {});
        connection.close();
      } catch {
        // Not running.
      }
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export async function waitFor<T>(
  probe: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (accept(last)) return last;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `condition not met; last value ${JSON.stringify(last)}${lastError ? `; last error ${String(lastError)}` : ""}`,
  );
}
