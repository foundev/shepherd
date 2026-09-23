/** A PTY master inherited from a previous daemon during live handoff.
 * node-pty cannot adopt an existing fd, so this wraps the fd the same way
 * node-pty does internally (a net.Socket over a pipe handle) and resizes
 * through node-pty's native binding. */
import { createRequire } from "node:module";
import net from "node:net";

type Listener<T> = (value: T) => void;

interface PtyBinding {
  resize(fd: number, cols: number, rows: number): void;
}

const nodeRequire = createRequire(import.meta.url);

function binding(): PtyBinding {
  try {
    return nodeRequire("node-pty/build/Release/pty.node") as PtyBinding;
  } catch {
    return nodeRequire("node-pty/build/Debug/pty.node") as PtyBinding;
  }
}

function socketForFd(fd: number): net.Socket {
  const internal = (process as unknown as {
    binding(name: string): {
      Pipe: new (type: number) => { open(fd: number): void };
      constants: { SOCKET: number };
    };
  }).binding("pipe_wrap");
  const handle = new internal.Pipe(internal.constants.SOCKET);
  handle.open(fd);
  return new net.Socket({ handle } as unknown as net.SocketConstructorOpts);
}

export class AdoptedPty {
  readonly pid: number;
  readonly fd: number;
  cols: number;
  rows: number;
  private readonly socket: net.Socket;
  private readonly dataListeners = new Set<Listener<string>>();
  private readonly exitListeners = new Set<Listener<{ exitCode: number; signal?: number }>>();
  private exited = false;

  constructor(fd: number, pid: number, cols: number, rows: number) {
    this.fd = fd;
    this.pid = pid;
    this.cols = cols;
    this.rows = rows;
    this.socket = socketForFd(fd);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (data: string) => {
      for (const listener of this.dataListeners) listener(data);
    });
    // EIO when the last process on the terminal exits closes the socket.
    this.socket.on("error", () => this.finish());
    this.socket.on("close", () => this.finish());
  }

  get process(): string {
    return "";
  }

  onData(listener: Listener<string>): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: Listener<{ exitCode: number; signal?: number }>): { dispose(): void } {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  write(data: string): void {
    if (!this.exited) this.socket.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    this.cols = cols;
    this.rows = rows;
    binding().resize(this.fd, cols, rows);
  }

  kill(signal = "SIGHUP"): void {
    try {
      process.kill(this.pid, signal as NodeJS.Signals);
    } catch {
      // Already gone.
    }
    this.socket.destroy();
  }

  private finish(): void {
    if (this.exited) return;
    this.exited = true;
    // The exit status belonged to the previous daemon; report a clean exit.
    for (const listener of this.exitListeners) listener({ exitCode: 0 });
  }
}
