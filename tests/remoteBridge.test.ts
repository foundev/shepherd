import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ClientConnection } from "../src/client/connection.js";
import {
  ChildStream,
  handshake,
  openChildBridge,
  runBridgeServer,
} from "../src/remote/bridge.js";
import type { EventFrame } from "../src/types.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A child that behaves like a bridge to a daemon: answers every request
 * line with ok, and after the first reply emits an event. */
const FAKE_DAEMON = `
let buffer = "";
let first = true;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const message = JSON.parse(line);
    const result = message.type === "hello"
      ? { product: "shepherd", protocolVersion: 1 }
      : { echoed: message.type };
    let out = JSON.stringify({ id: message.id, ok: true, result }) + "\\n";
    if (first) {
      out += JSON.stringify({ event: "state.changed", data: { n: 1 }, emittedAt: "now" }) + "\\n";
      first = false;
    }
    process.stdout.write(out);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

function fakeDaemonChild() {
  const child = spawn(process.execPath, ["-e", FAKE_DAEMON], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  cleanups.push(() => child.kill("SIGKILL"));
  return child;
}

describe("bridge client stream", () => {
  it("handshakes, keeps bytes after the reply, and carries requests", async () => {
    const stream = await openChildBridge(fakeDaemonChild(), 5_000);
    const events: EventFrame[] = [];
    const connection = ClientConnection.open(stream, (event) => events.push(event));
    cleanups.push(() => connection.close());
    // The event arrived in the same chunk as the hello reply.
    await waitFor(() => events.length === 1);
    expect(events[0]?.event).toBe("state.changed");
    await expect(connection.request({ type: "state.get" })).resolves.toEqual({
      echoed: "state.get",
    });
  });

  it("reports the child's stderr when it exits before answering", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "process.stderr.write('deploy@box: Permission denied (publickey).\\n'); process.exit(255)",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    await expect(openChildBridge(child, 5_000)).rejects.toThrow("Permission denied (publickey).");
    expect(child.exitCode).toBe(255);
  });

  it("closes the stream when the child exits and rejects pending requests", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "process.stdin.once('data', () => process.exit(0))",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const stream = new ChildStream(child);
    const closed = new Promise((resolve) => stream.once("close", resolve));
    const connection = ClientConnection.open(stream);
    await expect(connection.request({ type: "state.get" }, 5_000)).rejects.toThrow();
    await closed;
    expect(connection.connected).toBe(false);
  });

  it("times out a silent handshake", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    cleanups.push(() => child.kill("SIGKILL"));
    await expect(handshake(new ChildStream(child), 200)).rejects.toThrow("timed out");
  });
});

describe("bridge server", () => {
  async function echoServer() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-bridge-"));
    const socketPath = path.join(directory, "d.sock");
    const server = net.createServer((socket) => {
      socket.on("data", (chunk) => socket.write(chunk.toString("utf8").toUpperCase()));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanups.push(() => {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    return socketPath;
  }

  it("copies both directions and ends when input closes", async () => {
    const socket = net.createConnection(await echoServer());
    await new Promise((resolve) => socket.once("connect", resolve));
    const input = new PassThrough();
    const output = new PassThrough();
    let received = "";
    output.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
    });
    const done = runBridgeServer({ socket, input, output, idleTimeoutMs: 0 });
    input.write("hello\n");
    await waitFor(() => received === "HELLO\n");
    input.end();
    await expect(done).resolves.toBe("input-closed");
    expect(socket.destroyed).toBe(true);
  });

  it("closes an idle link and ends when the daemon goes away", async () => {
    const socketPath = await echoServer();
    const idleSocket = net.createConnection(socketPath);
    await new Promise((resolve) => idleSocket.once("connect", resolve));
    const started = Date.now();
    await expect(runBridgeServer({
      socket: idleSocket,
      input: new PassThrough(),
      output: new PassThrough(),
      idleTimeoutMs: 200,
    })).resolves.toBe("idle");
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);

    const socket = net.createConnection(socketPath);
    await new Promise((resolve) => socket.once("connect", resolve));
    const done = runBridgeServer({
      socket,
      input: new PassThrough(),
      output: new PassThrough(),
      idleTimeoutMs: 0,
    });
    socket.destroy();
    await expect(done).resolves.toBe("daemon-closed");
  });

  it("counts traffic as activity", async () => {
    const socket = net.createConnection(await echoServer());
    await new Promise((resolve) => socket.once("connect", resolve));
    const input = new PassThrough();
    let clock = 0;
    const done = runBridgeServer({
      socket,
      input,
      output: new PassThrough(),
      idleTimeoutMs: 1_000,
      now: () => clock,
    });
    clock = 900;
    input.write("ping\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    clock = 1_500;
    await new Promise((resolve) => setTimeout(resolve, 300));
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    clock = 2_000;
    await expect(done).resolves.toBe("idle");
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
