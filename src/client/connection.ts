import type { Duplex } from "node:stream";
import { decodeStream, encodeMessage } from "../protocol.js";
import type {
  ShepherdRequest,
  ShepherdResponse,
  EventFrame,
  WireMessage,
} from "../types.js";

interface PendingRequest {
  resolve: (response: ShepherdResponse) => void;
  reject: (error: Error) => void;
}

export interface ReconnectOptions {
  /** First retry delay. */
  initialDelayMs?: number;
  /** Retry delays double up to this. */
  maxDelayMs?: number;
}

/** Request/response client over any byte stream carrying Shepherd's NDJSON
 * protocol: the daemon's unix socket locally, or an ssh child's stdio for
 * `--remote`. */
export class ClientConnection {
  private socket: Duplex;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private buffer = "";
  private onEvent?: (event: EventFrame) => void;
  private closedByClient = false;
  private readonly reconnect?: () => Promise<Duplex>;
  private readonly backoff: Required<ReconnectOptions>;

  private constructor(
    socket: Duplex,
    onEvent?: (event: EventFrame) => void,
    reconnect?: () => Promise<Duplex>,
    backoff: ReconnectOptions = {},
  ) {
    this.socket = socket;
    this.onEvent = onEvent;
    this.reconnect = reconnect;
    this.backoff = {
      initialDelayMs: backoff.initialDelayMs ?? 200,
      maxDelayMs: backoff.maxDelayMs ?? 2_000,
    };
    this.attach(socket);
  }

  static open(
    socket: Duplex,
    onEvent?: (event: EventFrame) => void,
    reconnect?: () => Promise<Duplex>,
    backoff?: ReconnectOptions,
  ): ClientConnection {
    return new ClientConnection(socket, onEvent, reconnect, backoff);
  }

  /** Whether the current stream is usable. */
  get connected(): boolean {
    return !this.socket.destroyed && this.socket.writable;
  }

  private attach(socket: Duplex): void {
    this.socket = socket;
    this.buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", this.handleData);
    socket.on("error", () => this.rejectAll(new Error("socket error")));
    socket.on("close", () => {
      this.rejectAll(new Error("socket closed"));
      if (socket === this.socket) void this.restore();
    });
    // A stream handed over explicitly paused (after a bridge handshake)
    // stays paused when a data listener is added.
    socket.resume();
  }

  /** Reconnects with backoff after the daemon connection drops, emitting
   * `connection.lost` and `connection.restored` pseudo-events. */
  private async restore(): Promise<void> {
    if (this.closedByClient || !this.reconnect) return;
    this.emitLocal("connection.lost");
    let delay = this.backoff.initialDelayMs;
    while (!this.closedByClient) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (this.closedByClient) return;
      try {
        const socket = await this.reconnect();
        if (this.closedByClient) {
          socket.end();
          return;
        }
        this.attach(socket);
        this.emitLocal("connection.restored");
        return;
      } catch {
        delay = Math.min(this.backoff.maxDelayMs, delay * 2);
      }
    }
  }

  private emitLocal(event: string): void {
    this.onEvent?.({ event, data: {}, emittedAt: new Date().toISOString() });
  }

  request(
    request: ShepherdRequest,
    timeoutMs = 4_000,
  ): Promise<unknown> {
    const id = `c${this.nextId}`;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      if (this.socket.destroyed || !this.socket.writable) {
        reject(new Error("connection closed"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timed out: ${request.type}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          if (response.ok) resolve(response.result);
          else reject(new Error(response.error));
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.write(encodeMessage({ id, ...request }));
    });
  }

  close(): void {
    this.closedByClient = true;
    this.rejectAll(new Error("client closed"));
    this.socket.end();
  }

  /** Drops the current stream, for example after a failed health check.
   * With a reconnect function this starts the normal restore loop. */
  drop(): void {
    this.socket.destroy();
  }

  setEventHandler(onEvent: ((event: EventFrame) => void) | undefined): void {
    this.onEvent = onEvent;
  }

  private handleData = (chunk: string): void => {
    this.buffer += chunk;
    const { messages, remainder } = decodeStream(this.buffer);
    this.buffer = remainder;
    for (const message of messages) this.dispatch(message);
  };

  private dispatch(message: WireMessage): void {
    if (!("ok" in message)) {
      const frame = message as EventFrame;
      if (typeof frame.event === "string") this.onEvent?.(frame);
      return;
    }
    if (!("id" in message)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.resolve(message);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
