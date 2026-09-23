/** The byte pipe between a local client and a remote daemon.
 *
 * Remote side: `shepherd server bridge` connects to its own daemon's unix
 * socket and copies stdin to the socket and the socket to stdout
 * (`runBridgeServer`). Local side: ssh runs that command, and its stdio
 * becomes a Duplex (`ChildStream`) that `ClientConnection` speaks NDJSON
 * over exactly as it would over the socket. */
import type { ChildProcess } from "node:child_process";
import { Duplex, type Readable, type Writable } from "node:stream";
import { decodeStream, encodeMessage } from "../protocol.js";
import type { ShepherdResponse } from "../types.js";

/** Duplex over a child's stdin/stdout. Closes when the child exits; keeps
 * the tail of its stderr for error messages. */
export class ChildStream extends Duplex {
  readonly child: ChildProcess;
  stderrText = "";
  exitCode: number | null = null;
  private stdoutEnded = false;
  private exited = false;

  constructor(child: ChildProcess) {
    // Closed explicitly once the child has exited, so 'close' listeners
    // can read its exit code and stderr.
    super({ allowHalfOpen: false, autoDestroy: false });
    this.child = child;
    const stdout = child.stdout;
    const stdin = child.stdin;
    if (!stdout || !stdin) throw new Error("child process needs piped stdin and stdout");
    stdout.on("data", (chunk: Buffer) => {
      if (!this.push(chunk)) stdout.pause();
    });
    stdout.on("end", () => {
      this.stdoutEnded = true;
      this.push(null);
      if (this.exited) this.destroy();
    });
    stdin.on("error", () => {
      // EPIPE after the child exits; the exit handler closes the stream.
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrText = `${this.stderrText}${chunk.toString("utf8")}`.slice(-4_000);
    });
    child.once("error", (error) => this.destroy(error));
    child.once("exit", (code) => {
      this.exited = true;
      this.exitCode = code;
      if (this.stdoutEnded) {
        this.destroy();
        return;
      }
      // Give buffered stdout a moment to drain before closing.
      setTimeout(() => {
        if (!this.destroyed) {
          this.push(null);
          this.destroy();
        }
      }, 100).unref?.();
    });
  }

  /** Last non-empty stderr line, for status messages. */
  lastError(): string {
    const lines = this.stderrText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines[lines.length - 1] ?? "";
  }

  override _read(): void {
    this.child.stdout?.resume();
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const stdin = this.child.stdin;
    if (!stdin || !stdin.writable) {
      callback(new Error("bridge closed"));
      return;
    }
    stdin.write(chunk, encoding, (error) => callback(error ?? null));
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.child.stdin?.end();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
    }
    callback(error);
  }
}

/** Sends `hello` and waits for the daemon's reply, proving the whole path
 * (ssh, remote command, remote daemon) works. Leaves the stream paused
 * with any bytes after the reply unshifted. */
export function handshake(
  stream: Duplex,
  timeoutMs: number,
): Promise<{ product: string; protocolVersion: number }> {
  return new Promise((resolve, reject) => {
    const id = `bridge-hello-${process.pid}-${Date.now()}`;
    let buffer = "";
    const finish = (
      error: Error | null,
      result?: { product: string; protocolVersion: number },
      remainder = "",
    ) => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("close", onClose);
      stream.removeListener("error", onError);
      stream.pause();
      // Only after detaching, or unshift re-enters onData.
      if (remainder) stream.unshift(Buffer.from(remainder, "utf8"));
      if (error) reject(error);
      else resolve(result as { product: string; protocolVersion: number });
    };
    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        if (buffer.length > 1_000_000) finish(new Error("bridge sent no reply line"));
        return;
      }
      const { messages } = decodeStream(buffer.slice(0, newline + 1));
      const remainder = buffer.slice(newline + 1);
      const reply = messages[0] as ShepherdResponse | undefined;
      if (!reply || !("id" in reply) || reply.id !== id) {
        finish(new Error("bridge did not answer with a Shepherd reply"));
        return;
      }
      if (!reply.ok) {
        finish(new Error(reply.error));
        return;
      }
      const result = reply.result as { product?: unknown; protocolVersion?: unknown };
      if (result?.product !== "shepherd") {
        finish(new Error("remote endpoint is not a Shepherd daemon"));
        return;
      }
      finish(null, {
        product: "shepherd",
        protocolVersion: typeof result.protocolVersion === "number" ? result.protocolVersion : 1,
      }, remainder);
    };
    const onClose = () => {
      const detail = stream instanceof ChildStream ? stream.lastError() : "";
      finish(new Error(detail || "bridge closed before the remote daemon answered"));
    };
    const onError = (error: Error) => finish(error);
    const timer = setTimeout(() => {
      finish(new Error(`bridge handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    stream.on("data", onData);
    stream.once("close", onClose);
    stream.once("error", onError);
    stream.write(encodeMessage({ id, type: "hello" }));
  });
}

/** Opens `child` as a bridge and completes the handshake. Kills the child
 * when the handshake fails. */
export async function openChildBridge(
  child: ChildProcess,
  timeoutMs = 20_000,
): Promise<ChildStream> {
  const stream = new ChildStream(child);
  try {
    await handshake(stream, timeoutMs);
    return stream;
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

export interface BridgeServerOptions {
  socket: Duplex;
  input: Readable;
  output: Writable;
  /** Close after this long with no bytes in either direction; 0 disables. */
  idleTimeoutMs: number;
  now?: () => number;
}

/** Copies `input` to the daemon socket and the socket to `output` until
 * either side closes or the link goes idle. Resolves with why it ended. */
export function runBridgeServer(
  options: BridgeServerOptions,
): Promise<"input-closed" | "daemon-closed" | "idle"> {
  const { socket, input, output, idleTimeoutMs } = options;
  const now = options.now ?? Date.now;
  let lastActivity = now();
  return new Promise((resolve) => {
    let done = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (reason: "input-closed" | "daemon-closed" | "idle") => {
      if (done) return;
      done = true;
      if (timer) clearInterval(timer);
      input.removeListener("data", fromInput);
      socket.removeListener("data", fromSocket);
      if (!socket.destroyed) socket.destroy();
      resolve(reason);
    };
    const fromInput = (chunk: Buffer) => {
      lastActivity = now();
      if (!socket.write(chunk)) {
        input.pause();
        socket.once("drain", () => input.resume());
      }
    };
    const fromSocket = (chunk: Buffer) => {
      lastActivity = now();
      if (!output.write(chunk)) {
        socket.pause();
        output.once("drain", () => socket.resume());
      }
    };
    input.on("data", fromInput);
    input.once("end", () => finish("input-closed"));
    input.once("close", () => finish("input-closed"));
    input.once("error", () => finish("input-closed"));
    output.once("error", () => finish("input-closed"));
    socket.on("data", fromSocket);
    socket.once("close", () => finish("daemon-closed"));
    socket.once("error", () => finish("daemon-closed"));
    if (idleTimeoutMs > 0) {
      // Compare wall-clock time so a suspended host notices on wake-up.
      const check = Math.max(50, Math.min(5_000, Math.floor(idleTimeoutMs / 4)));
      timer = setInterval(() => {
        if (now() - lastActivity >= idleTimeoutMs) finish("idle");
      }, check);
    }
    input.resume();
  });
}
