import { EventEmitter } from "node:events";

export interface HostCursor {
  x: number;
  y: number;
  shape: "block" | "underline" | "bar";
  blink: boolean;
}

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/** Writes full-screen frames to the host terminal, rewriting only the rows
 * that changed and placing the cursor itself. Ink renders into this (as its
 * debug-mode stdout) instead of clearing and redrawing the whole screen. */
export class ScreenWriter extends EventEmitter {
  private readonly output: NodeJS.WriteStream;
  private previous: string[] = [];
  private pending: string[] | null = null;
  private cursor: HostCursor | null = null;
  private writtenCursor = "";
  private writtenShape = "";
  private timer: NodeJS.Timeout | null = null;
  private lastFlush = 0;
  private readonly minInterval: number;

  constructor(output: NodeJS.WriteStream, maxFps = 60) {
    super();
    this.output = output;
    this.minInterval = Math.floor(1000 / maxFps);
    output.on("resize", this.onResize);
  }

  get columns(): number {
    return this.output.columns ?? 120;
  }

  get rows(): number {
    return this.output.rows ?? 40;
  }

  get isTTY(): boolean {
    return true;
  }

  /** Ink writes each rendered frame here. */
  write(data: string | Uint8Array, callback?: (error?: Error | null) => void): boolean {
    const frame = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    if (frame.length > 0) {
      this.pending = frame.split("\n");
      this.schedule();
    }
    callback?.();
    return true;
  }

  /** Bytes for the host terminal itself (bells, OSC 52, mode switches). */
  passthrough(data: string): void {
    this.output.write(data);
  }

  setCursor(cursor: HostCursor | null): void {
    const key = cursor ? `${cursor.x},${cursor.y}` : "";
    const shape = cursor ? `${cursor.shape}:${cursor.blink}` : this.writtenShape;
    if (key === this.writtenCursor && shape === this.writtenShape) {
      this.cursor = cursor;
      return;
    }
    this.cursor = cursor;
    this.schedule();
  }

  /** Forget what is on screen so the next frame redraws everything. */
  invalidate(): void {
    this.previous = [];
    this.writtenCursor = "";
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flush();
    this.output.off("resize", this.onResize);
    this.output.write(`${SHOW_CURSOR}\x1b[0 q`);
  }

  private onResize = () => {
    this.invalidate();
    this.output.write("\x1b[2J");
    this.emit("resize");
  };

  private schedule(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.minInterval - (Date.now() - this.lastFlush));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  private flush(): void {
    this.lastFlush = Date.now();
    let buffer = "";
    const lines = this.pending;
    this.pending = null;
    if (lines) {
      const height = Math.min(lines.length, this.rows);
      for (let row = 0; row < height; row += 1) {
        const line = lines[row] ?? "";
        if (line === this.previous[row]) continue;
        buffer += `\x1b[${row + 1};1H${line}\x1b[0m\x1b[K`;
      }
      for (let row = height; row < this.previous.length && row < this.rows; row += 1) {
        buffer += `\x1b[${row + 1};1H\x1b[0m\x1b[K`;
      }
      this.previous = lines.slice(0, height);
    }

    const cursor = this.cursor;
    const cursorKey = cursor ? `${cursor.x},${cursor.y}` : "";
    const shapeKey = cursor ? `${cursor.shape}:${cursor.blink}` : this.writtenShape;
    if (!buffer && cursorKey === this.writtenCursor && shapeKey === this.writtenShape) {
      return;
    }
    if (cursor) {
      if (shapeKey !== this.writtenShape) {
        buffer += `\x1b[${cursorShapeCode(cursor)} q`;
      }
      buffer += `\x1b[${cursor.y + 1};${cursor.x + 1}H${SHOW_CURSOR}`;
    }
    this.writtenCursor = cursorKey;
    this.writtenShape = shapeKey;
    this.output.write(`${SYNC_START}${HIDE_CURSOR}${buffer}${SYNC_END}`);
  }
}

function cursorShapeCode(cursor: HostCursor): number {
  const base = cursor.shape === "underline" ? 3 : cursor.shape === "bar" ? 5 : 1;
  return cursor.blink ? base : base + 1;
}

/** Writes bytes meant for the host terminal, bypassing Ink's frame output
 * when a ScreenWriter is in use. */
export function writeHost(stream: NodeJS.WriteStream, data: string): void {
  const writer = stream as unknown as Partial<ScreenWriter>;
  if (typeof writer.passthrough === "function") writer.passthrough(data);
  else stream.write(data);
}
