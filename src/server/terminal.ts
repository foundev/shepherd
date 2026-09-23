import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import pty from "node-pty";
import type {
  AgentStatus,
  AgentTask,
  CursorView,
  ReadSource,
  TerminalLine,
  TerminalSpan,
} from "../types.js";
import { detectAgentFromCommand } from "./detection/agents.js";
import { AgentDetector } from "./detection/detector.js";
import { AdoptedPty } from "./adoptedPty.js";
import { KittyKeyboardState } from "./kittyKeyboard.js";
import { MetadataStore } from "./metadata.js";
import type { DetectionInput } from "./detection/engine.js";
import type { DetectedState } from "./detection/manifest.js";

type HeadlessTerminalConstructor = new (
  options: ConstructorParameters<typeof import("@xterm/headless").Terminal>[0],
) => import("@xterm/headless").Terminal;
type HeadlessTerminal = InstanceType<HeadlessTerminalConstructor>;

const nodeRequire = createRequire(import.meta.url);
const { Terminal } = nodeRequire("@xterm/headless") as {
  Terminal: HeadlessTerminalConstructor;
};

const _UNUSED_BLOCKED_PATTERNS: RegExp[] = [
  /(?:continue|proceed)[^\n]{0,100}\?[^\n]{0,30}$/im,
  /(?:approve|allow|deny)[^\n]{0,100}(?:\[[^\]]+\]|\([^)]+\))\s*:?\s*$/im,
  /(?:\[[yn /|]+\]|\((?:y\/n|yes\/no)\))\s*$/im,
  /\bwaiting for (?:your )?(?:input|approval)\b/i,
  /\bpress enter\b/i,
  /\bselect an option\b/i,
];

export interface PaneTerminalOptions {
  id: string;
  title: string;
  cwd: string;
  command: string | null;
  initialCols?: number;
  initialRows?: number;
  env?: Record<string, string>;
  /** A line shown in the pane before its shell starts (restore errors). */
  notice?: string;
  /** Take over a PTY master from a previous daemon instead of spawning. */
  adopt?: { fd: number; pid: number };
  /** Screen, scrollback and modes to replay into the emulator (handoff). */
  replay?: string;
  /** Shell for interactive panes and for running `command`. */
  shell?: { file: string; args: string[] };
  scrollbackLines?: number;
  /** Called when the pane process exits on its own (not via close()). */
  onExit?: (exitCode: number) => void;
  onBell?: () => void;
  /** Called after output has been parsed into the screen. */
  onChange?: () => void;
  /** The app wrote to the clipboard with OSC 52. */
  onClipboard?: (text: string) => void;
}

/** Largest OSC 52 payload accepted from an app (decoded bytes). */
const MAX_CLIPBOARD_BYTES = 192 * 1024;


export interface PaneMouseEvent {
  col: number;
  row: number;
  button: "left" | "middle" | "right" | "none" | "wheel";
  /** For wheel events, `up` or `down`. */
  action: "press" | "release" | "move" | "drag" | "up" | "down";
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface PaneModes {
  applicationCursorKeys: boolean;
  bracketedPaste: boolean;
  mouseTracking: "none" | "x10" | "vt200" | "drag" | "any";
  sendFocus: boolean;
  alternateScreen: boolean;
  /** Kitty keyboard protocol flags the app enabled (0 = legacy keys). */
  kittyKeyboard: number;
  /** xterm modifyOtherKeys level (0-2). */
  modifyOtherKeys: number;
}

/** Environment markers from other multiplexers and terminals that would
 * confuse programs running inside a Shepherd pane. */
const STRIPPED_ENV_PREFIXES = [
  "TMUX",
  "ZELLIJ",
  "STY",
  "ITERM_",
  "WEZTERM_",
  "KITTY_",
  "WT_",
  "TERM_SESSION_ID",
  "LC_TERMINAL",
];

const CURSOR_KEYS: Record<string, string> = {
  "\x1b[A": "\x1bOA",
  "\x1b[B": "\x1bOB",
  "\x1b[C": "\x1bOC",
  "\x1b[D": "\x1bOD",
  "\x1b[H": "\x1bOH",
  "\x1b[F": "\x1bOF",
};

export class PaneTerminal {
  readonly id: string;
  title: string;
  readonly cwd: string;
  readonly command: string | null;
  readonly createdAt: string;
  /** Agent identification and status (Shepherd's detection loop). */
  readonly detector = new AgentDetector();
  exitCode: number | null = null;
  lastOutputAt = Date.now();
  terminalTitle = "";
  /** Last OSC 9 payload (progress reports such as "4;3;"). */
  oscProgress = "";
  currentCwd: string;
  /** Command line of the terminal's foreground job, if not the shell. */
  foregroundCommand: string | null = null;
  /** Keyboard protocol the pane's app asked for. */
  private readonly keyboard = new KittyKeyboardState();
  /** Metadata reported by integrations and scripts. */
  readonly metadata = new MetadataStore();
  /** Session the pane's agent reported through an integration. */
  agentSession: { source: string; agent: string; value: string } | null = null;
  task: AgentTask | null = null;
  continuity: "live" | "restarted" | "resuming" | "handoff" = "live";
  /** Increments whenever parsed output changes the screen. */
  revision = 0;

  private readonly notifyChange?: () => void;
  private readonly ptyProcess: pty.IPty | AdoptedPty;
  private readonly terminal: HeadlessTerminal;
  private closed = false;

  constructor(options: PaneTerminalOptions) {
    this.id = options.id;
    this.title = options.title;
    this.cwd = options.cwd;
    this.currentCwd = options.cwd;
    this.notifyChange = options.onChange;
    this.command = options.command ?? null;
    this.createdAt = new Date().toISOString();
    this.detector.setAgent(detectAgentFromCommand(options.command ?? ""), Date.now());

    const cols = safeDimension(options.initialCols ?? 100, 8, 500);
    const rows = safeDimension(options.initialRows ?? 30, 4, 250);
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: options.scrollbackLines ?? 10_000,
      convertEol: false,
      allowProposedApi: true,
    });

    if (options.replay) this.terminal.write(options.replay);
    if (options.adopt) {
      this.ptyProcess = new AdoptedPty(options.adopt.fd, options.adopt.pid, cols, rows);
    } else {
      const shell = paneShell(this.command, options.shell);
      this.ptyProcess = pty.spawn(shell.file, shell.args, {
        name: "xterm-256color",
        cwd: options.cwd,
        cols,
        rows,
        env: paneEnvironment(options.id, options.env),
      });
    }

    if (options.notice) {
      this.terminal.write(`\x1b[33m${options.notice}\x1b[0m\r\n`);
    }

    // Replies to terminal queries (cursor position, device attributes,
    // colour queries) are produced by the emulator and must reach the app.
    this.terminal.onData((data) => this.write(data));
    this.keyboard.attach(this.terminal, (data) => this.write(data));
    this.terminal.onBinary((data) => {
      this.write(data);
    });
    this.terminal.onTitleChange((title) => {
      this.terminalTitle = sanitizeTitle(title);
    });
    this.terminal.onBell(() => options.onBell?.());
    this.terminal.parser.registerOscHandler(52, (data) => {
      const text = clipboardFromOsc52(data);
      if (text !== null) options.onClipboard?.(text);
      return true;
    });
    this.terminal.parser.registerOscHandler(9, (data) => {
      this.oscProgress = sanitizeTitle(data);
      return false;
    });
    this.terminal.parser.registerOscHandler(7, (data) => {
      const cwd = cwdFromOsc7(data);
      if (cwd) this.currentCwd = cwd;
      return true;
    });

    this.ptyProcess.onData((data) => {
      this.terminal.write(data, () => {
        this.revision += 1;
        this.notifyChange?.();
      });
      this.lastOutputAt = Date.now();
      if (data.length > 0) this.detector.noteOutput();
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      this.exitCode = exitCode;
      if (!this.closed) options.onExit?.(exitCode);
    });

    if (this.command && process.platform === "win32") {
      queueMicrotask(() => this.write(`${this.command}\r`));
    }
  }

  get modes(): PaneModes {
    const modes = this.terminal.modes;
    return {
      applicationCursorKeys: modes.applicationCursorKeysMode,
      bracketedPaste: modes.bracketedPasteMode,
      mouseTracking: modes.mouseTrackingMode,
      sendFocus: modes.sendFocusMode,
      alternateScreen: this.terminal.buffer.active.type === "alternate",
      kittyKeyboard: this.keyboard.flags,
      modifyOtherKeys: this.keyboard.modifyOtherKeys,
    };
  }

  get processId(): number | undefined {
    return this.ptyProcess.pid;
  }

  write(data: string): void {
    if (this.closed) return;
    this.ptyProcess.write(data);
  }

  /** Keyboard input from an attached client. Cursor keys follow DECCKM and
   * any typing returns the viewport to the live screen. */
  input(data: string): void {
    const translated = this.terminal.modes.applicationCursorKeysMode
      ? CURSOR_KEYS[data] ?? data
      : data;
    this.scrollToBottom();
    this.write(translated);
  }

  /** Reports a mouse event to the app using whatever mouse protocol and
   * encoding it enabled. Returns false when the app is not tracking. */
  mouse(event: PaneMouseEvent): boolean {
    if (this.terminal.modes.mouseTrackingMode === "none") return false;
    const service = (this.terminal as unknown as {
      _core?: {
        coreMouseService?: {
          triggerMouseEvent: (event: Record<string, unknown>) => boolean;
        };
      };
    })._core?.coreMouseService;
    if (!service) return false;
    const button = event.button === "wheel"
      ? 4
      : event.button === "middle"
        ? 1
        : event.button === "right"
          ? 2
          : event.button === "none"
            ? 3
            : 0;
    const action = event.button === "wheel"
      ? (event.action === "up" ? 0 : 1)
      : event.action === "release"
        ? 0
        : event.action === "move"
          ? 32
          : 1;
    return service.triggerMouseEvent({
      col: Math.max(0, Math.min(this.terminal.cols - 1, event.col)),
      row: Math.max(0, Math.min(this.terminal.rows - 1, event.row)),
      x: 0,
      y: 0,
      button,
      action,
      ctrl: event.ctrl ?? false,
      alt: event.alt ?? false,
      shift: event.shift ?? false,
    });
  }

  /** Clears scrollback and the screen above the cursor line (Shepherd's
   * clear_pane). Does nothing on the alternate screen. */
  clear(): void {
    if (this.terminal.buffer.active.type === "alternate") return;
    this.terminal.clear();
    this.revision += 1;
    this.notifyChange?.();
  }

  /** Sends a focus-in or focus-out report when the app asked for them. */
  focus(focused: boolean): void {
    if (this.terminal.modes.sendFocusMode) {
      this.write(focused ? "\x1b[I" : "\x1b[O");
    }
  }

  private scrollToBottom(): void {
    const buffer = this.terminal.buffer.active;
    if (buffer.viewportY === buffer.baseY) return;
    this.terminal.scrollToBottom();
    this.revision += 1;
    this.notifyChange?.();
  }

  paste(text: string): void {
    const normalized = text.replace(/\r?\n/g, "\r");
    this.scrollToBottom();
    if (this.terminal.modes.bracketedPasteMode) {
      const safe = normalized.replaceAll("\x1b[201~", "");
      this.write(`\x1b[200~${safe}\x1b[201~`);
    } else {
      this.write(normalized);
    }
  }

  resize(cols: number, rows: number): void {
    const safeCols = safeDimension(cols, 2, 500);
    const safeRows = safeDimension(rows, 1, 250);
    if (safeCols === this.terminal.cols && safeRows === this.terminal.rows) {
      return;
    }
    this.terminal.resize(safeCols, safeRows);
    if (!this.closed) this.ptyProcess.resize(safeCols, safeRows);
    this.revision += 1;
    this.notifyChange?.();
  }

  get cols(): number {
    return this.terminal.cols;
  }

  get rows(): number {
    return this.terminal.rows;
  }

  /** Cursor position within the visible viewport. */
  cursor(): CursorView {
    const buffer = this.terminal.buffer.active;
    const core = (this.terminal as unknown as {
      _core?: {
        coreService?: { isCursorHidden?: boolean };
        optionsService?: {
          rawOptions?: { cursorStyle?: string; cursorBlink?: boolean };
        };
      };
    })._core;
    const y = buffer.baseY + buffer.cursorY - buffer.viewportY;
    const style = core?.optionsService?.rawOptions?.cursorStyle;
    return {
      x: buffer.cursorX,
      y,
      visible: core?.coreService?.isCursorHidden !== true &&
        y >= 0 &&
        y < this.terminal.rows,
      shape: style === "underline" || style === "bar" ? style : "block",
      blink: core?.optionsService?.rawOptions?.cursorBlink ?? false,
    };
  }

  /** Plain text of buffer lines [start, start + count), trailing blanks
   * trimmed, plus which lines continue the previous one (soft wraps). */
  text(start: number, count: number): {
    start: number;
    lines: string[];
    wrapped: boolean[];
    total: number;
    baseLine: number;
  } {
    const buffer = this.terminal.buffer.active;
    const from = Math.max(0, Math.min(buffer.length, Math.floor(start)));
    const to = Math.max(from, Math.min(buffer.length, from + Math.floor(count)));
    const lines: string[] = [];
    const wrapped: boolean[] = [];
    for (let index = from; index < to; index += 1) {
      const line = buffer.getLine(index);
      lines.push(line?.translateToString(true) ?? "");
      wrapped.push(line?.isWrapped ?? false);
    }
    return { start: from, lines, wrapped, total: buffer.length, baseLine: buffer.baseY };
  }

  /** Finds `query` from a position, case-insensitive unless the query has
   * an uppercase letter (smart case). Wraps around the buffer. */
  search(
    query: string,
    from: { line: number; col: number },
    direction: "forward" | "backward",
  ): { line: number; col: number; length: number } | null {
    if (!query) return null;
    const buffer = this.terminal.buffer.active;
    const smart = query !== query.toLowerCase();
    const needle = smart ? query : query.toLowerCase();
    const total = buffer.length;
    const textAt = (index: number) => {
      const text = buffer.getLine(index)?.translateToString(true) ?? "";
      return smart ? text : text.toLowerCase();
    };
    for (let step = 0; step <= total; step += 1) {
      const index = direction === "forward"
        ? (from.line + step) % total
        : (from.line - step + total * 2) % total;
      const text = textAt(index);
      let col: number;
      if (direction === "forward") {
        const startCol = step === 0 ? from.col + 1 : 0;
        col = text.indexOf(needle, startCol);
      } else {
        const endCol = step === 0 ? from.col - 1 : text.length;
        col = endCol < 0 ? -1 : text.lastIndexOf(needle, endCol);
      }
      if (col !== -1) return { line: index, col, length: [...query].length };
    }
    return null;
  }

  /** The link under a cell: an OSC 8 hyperlink, or an http(s) URL in the
   * logical line (soft-wrapped rows joined). `line` is an absolute buffer
   * line. */
  linkAt(line: number, col: number): string | null {
    return this.linkSpanAt(line, col)?.url ?? null;
  }

  /** The link under a cell and the cells it covers, row by row (inclusive
   * columns, absolute buffer lines). */
  linkSpanAt(
    line: number,
    col: number,
  ): { url: string; cells: Array<{ line: number; start: number; end: number }> } | null {
    const buffer = this.terminal.buffer.active;
    let first = line;
    while (first > 0 && buffer.getLine(first)?.isWrapped) first -= 1;
    let last = line;
    while (buffer.getLine(last + 1)?.isWrapped) last += 1;

    const osc = this.hyperlinkReader();
    const target = osc?.(line, col);
    if (osc && target) {
      // The run of cells with this link id around the click, continued
      // through soft wraps while it touches the row edge.
      const cols = this.terminal.cols;
      const same = (index: number, x: number) => osc(index, x)?.id === target.id;
      const run = (index: number, from: number) => {
        let start = from;
        while (start > 0 && same(index, start - 1)) start -= 1;
        let end = from;
        while (end < cols - 1 && same(index, end + 1)) end += 1;
        return { line: index, start, end };
      };
      const cells = [run(line, col)];
      for (let index = line; index > first; index -= 1) {
        if (cells[0]!.start !== 0 || !same(index - 1, cols - 1)) break;
        cells.unshift(run(index - 1, cols - 1));
      }
      for (let index = line; index < last; index += 1) {
        if (cells.at(-1)!.end !== cols - 1 || !same(index + 1, 0)) break;
        cells.push(run(index + 1, 0));
      }
      return { url: target.uri, cells };
    }

    const rows: Array<{ line: number; text: string; offset: number }> = [];
    let text = "";
    let offset = 0;
    for (let index = first; index <= last; index += 1) {
      const row = buffer.getLine(index)?.translateToString(index === last) ?? "";
      rows.push({ line: index, text: row, offset: text.length });
      if (index === line) offset = text.length + col;
      text += row;
    }
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
      const url = match[0].replace(/[.,;:!?)\]}]+$/, "");
      const start = match.index ?? 0;
      if (offset < start || offset >= start + url.length) continue;
      const cells = rows.flatMap((row) => {
        const from = Math.max(start, row.offset);
        const to = Math.min(start + url.length, row.offset + row.text.length);
        return from < to
          ? [{ line: row.line, start: from - row.offset, end: to - row.offset - 1 }]
          : [];
      });
      return { url, cells };
    }
    return null;
  }

  /** Reads the OSC 8 link of a cell from xterm's internals, or null when
   * they are unavailable. */
  private hyperlinkReader(): ((line: number, col: number) => { id: number; uri: string } | null) | null {
    const core = (this.terminal as unknown as {
      _core?: {
        buffer?: {
          lines: { get(index: number): { loadCell(x: number, cell: unknown): unknown } | undefined };
          getNullCell(): { constructor: new () => { extended?: { urlId?: number } } };
        };
        _oscLinkService?: { getLinkData(id: number): { uri: string } | undefined };
      };
    })._core;
    const buffer = core?.buffer;
    const links = core?._oscLinkService;
    if (!buffer || !links) return null;
    return (line, col) => {
      try {
        const bufferLine = buffer.lines.get(line);
        if (!bufferLine) return null;
        const cell = new (buffer.getNullCell().constructor)();
        bufferLine.loadCell(col, cell);
        const id = cell.extended?.urlId;
        const uri = id ? links.getLinkData(id)?.uri : undefined;
        return id && uri ? { id, uri } : null;
      } catch {
        return null;
      }
    };
  }

  /** Index of the first line of the live screen in the buffer. */
  get baseLine(): number {
    return this.terminal.buffer.active.baseY;
  }

  /** A viewport starting at buffer line `top` (the live screen when null),
   * with the cursor translated into it. Used for per-client scrollback. */
  view(top: number | null): {
    lines: TerminalLine[];
    cursor: CursorView;
    scroll: { offsetFromBottom: number; maxOffsetFromBottom: number };
  } {
    const buffer = this.terminal.buffer.active;
    const start = top === null
      ? buffer.baseY
      : Math.max(0, Math.min(buffer.baseY, top));
    const lines: TerminalLine[] = [];
    for (let offset = 0; offset < this.terminal.rows; offset += 1) {
      const line = buffer.getLine(start + offset);
      lines.push(line ? styledLine(line, this.terminal.cols) : []);
    }
    const live = this.cursor();
    const y = buffer.baseY + buffer.cursorY - start;
    return {
      lines,
      cursor: {
        ...live,
        y,
        visible: live.visible && start === buffer.baseY,
      },
      scroll: {
        offsetFromBottom: buffer.baseY - start,
        maxOffsetFromBottom: buffer.baseY,
      },
    };
  }

  /** Lines between the viewport and the live screen. */
  scrollState(): { offsetFromBottom: number; maxOffsetFromBottom: number } {
    const buffer = this.terminal.buffer.active;
    return {
      offsetFromBottom: buffer.baseY - buffer.viewportY,
      maxOffsetFromBottom: buffer.baseY,
    };
  }

  snapshot(rows: number, source: ReadSource = "visible"): TerminalLine[] {
    const count = safeDimension(rows, 1, 200);
    const buffer = this.terminal.buffer.active;
    const lines: TerminalLine[] = [];
    const start = source === "visible"
      ? buffer.viewportY
      : Math.max(0, buffer.length - count);
    const wrapped: boolean[] = [];

    for (let offset = 0; offset < count; offset += 1) {
      const line = buffer.getLine(start + offset);
      wrapped.push(line?.isWrapped ?? false);
      lines.push(line ? styledLine(line, this.terminal.cols) : []);
    }

    return source === "recent-unwrapped"
      ? unwrapTerminalLines(lines, wrapped)
      : lines;
  }

  scroll(lines: number): void {
    const safeLines = Math.max(-500, Math.min(500, Math.floor(lines)));
    if (safeLines === 0) return;
    this.terminal.scrollLines(safeLines);
    this.revision += 1;
    this.notifyChange?.();
  }


  /** What a new daemon needs to take this pane over: the PTY master fd
   * and a replay of the emulator's scrollback, screen, cursor and modes. */
  handoffState(): { fd: number; pid: number; cols: number; rows: number; replay: string } | null {
    const fd = (this.ptyProcess as unknown as { fd?: number }).fd;
    const pid = this.ptyProcess.pid;
    if (typeof fd !== "number" || !pid) return null;
    return {
      fd,
      pid,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      replay: this.serializeForHandoff(),
    };
  }

  /** The normal screen and scrollback as ANSI text, soft-wrapped rows
   * joined so it reflows at a new width; null when empty. */
  historyAnsi(): string | null {
    const normal = this.terminal.buffer.normal;
    const cols = this.terminal.cols;
    let last = normal.length - 1;
    while (last >= 0 && !normal.getLine(last)?.translateToString(true).trim()) last -= 1;
    if (last < 0) return null;
    let out = "";
    for (let index = Math.max(0, normal.length - 5_000); index <= last; index += 1) {
      const line = normal.getLine(index);
      if (!line) continue;
      if (index > 0 && out && !line.isWrapped) out += "\x1b[0m\r\n";
      out += styledLine(line, cols).map(spanAnsi).join("");
    }
    return `${out}\x1b[0m\r\n`;
  }

  private serializeForHandoff(): string {
    const normal = this.terminal.buffer.normal;
    const alternate = this.terminal.buffer.active.type === "alternate";
    const cols = this.terminal.cols;
    const lineAnsi = (line: TerminalLine) => `${line.map(spanAnsi).join("")}\x1b[0m`;
    let out = "";
    // Scrollback and the normal screen, written top to bottom.
    const from = Math.max(0, normal.length - 5_000);
    const rows: string[] = [];
    for (let index = from; index < normal.length; index += 1) {
      const line = normal.getLine(index);
      rows.push(line ? lineAnsi(styledLine(line, cols)) : "");
    }
    // Every line through the bottom of the screen, so positions line up.
    out += rows.join("\r\n");
    if (!alternate) {
      out += `\x1b[${normal.cursorY + 1};${normal.cursorX + 1}H`;
    } else {
      out += "\x1b[?1049h\x1b[H\x1b[2J";
      const screen = this.terminal.buffer.alternate;
      for (let row = 0; row < this.terminal.rows; row += 1) {
        const line = screen.getLine(row);
        if (line) out += `\x1b[${row + 1};1H${lineAnsi(styledLine(line, cols))}`;
      }
      out += `\x1b[${screen.cursorY + 1};${screen.cursorX + 1}H`;
    }
    const modes = this.terminal.modes;
    if (modes.applicationCursorKeysMode) out += "\x1b[?1h";
    if (modes.applicationKeypadMode) out += "\x1b=";
    if (modes.bracketedPasteMode) out += "\x1b[?2004h";
    if (modes.sendFocusMode) out += "\x1b[?1004h";
    const mouse = { x10: "9", vt200: "1000", drag: "1002", any: "1003", none: "" }[
      modes.mouseTrackingMode
    ];
    if (mouse) out += `\x1b[?${mouse}h`;
    const encoding = (this.terminal as unknown as {
      _core?: { coreMouseService?: { activeEncoding?: string } };
    })._core?.coreMouseService?.activeEncoding;
    if (encoding === "SGR") out += "\x1b[?1006h";
    out += this.keyboard.replay();
    if (this.cursor().visible === false) out += "\x1b[?25l";
    if (this.terminalTitle) out += `\x1b]2;${this.terminalTitle}\x07`;
    return out;
  }

  get agent(): string | null {
    return this.detector.agent;
  }

  get status(): AgentStatus {
    return this.detector.status();
  }

  /** Screen text for detection: about one screen ending at the last
   * content or the cursor, lines right-trimmed, with a final newline. */
  detectionText(): string {
    const buffer = this.terminal.buffer.active;
    const rows = this.terminal.rows || 24;
    let start: number;
    let end: number;
    if (buffer.type === "alternate") {
      end = buffer.length - 1;
      start = Math.max(0, end - rows + 1);
    } else {
      let lastContent = -1;
      for (let index = buffer.baseY + rows - 1; index >= buffer.baseY; index -= 1) {
        if ((buffer.getLine(index)?.translateToString(true) ?? "").trim() !== "") {
          lastContent = index;
          break;
        }
      }
      end = Math.max(lastContent, buffer.baseY + buffer.cursorY);
      start = Math.max(0, end - rows + 1);
    }
    const lines: string[] = [];
    for (let index = start; index <= end; index += 1) {
      lines.push((buffer.getLine(index)?.translateToString(true) ?? "").replace(/\s+$/, ""));
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.length > 0 ? `${lines.join("\n")}\n` : "";
  }

  detectionInput(): DetectionInput {
    return {
      text: this.detectionText(),
      oscTitle: this.terminalTitle,
      oscProgress: this.oscProgress,
    };
  }

  /** One detection tick; true when the status changed. */
  detect(now: number, suppressed: boolean): boolean {
    return this.detector.tick(now, () => this.detectionInput(), suppressed);
  }

  /** Foreground probe result; true when the agent or status changed. */
  probeAgent(
    agent: string | null,
    command: string | null,
    shellInForeground: boolean,
    now: number,
    suppressed: boolean,
  ): boolean {
    this.foregroundCommand = command;
    return this.detector.probe(agent, shellInForeground, now, suppressed);
  }

  reportAgentState(state: DetectedState, source: string, suppressed: boolean): boolean {
    return this.detector.reportHook(state, source, Date.now(), suppressed);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ptyProcess.kill();
    } catch {
      // A PTY can disappear while a close request is already in flight.
    }
  }

  hasObservedStatusChange(): boolean {
    return this.detector.stateChangeSequence > 0 || this.exitCode !== null;
  }
}

export function detectAgent(command: string): string | null {
  return detectAgentFromCommand(command);
}

function paneShell(
  command: string | null,
  configured?: { file: string; args: string[] },
): { file: string; args: string[] } {
  const shell = configured ?? defaultShell();
  if (!command || process.platform === "win32") return shell;
  return { file: shell.file, args: [...shell.args, "-c", command] };
}

export function paneEnvironment(
  paneId: string,
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  return {
    ...env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "shepherd",
    TERM_PROGRAM_VERSION: SHEPHERD_VERSION,
    SHEPHERD_ENV: "1",
    SHEPHERD_PANE_ID: paneId,
    ...extra,
  };
}

const SHEPHERD_VERSION = "0.1.0";

export function cwdFromOsc7(data: string): string | null {
  try {
    const url = new URL(data);
    if (url.protocol !== "file:") return null;
    const pathname = decodeURIComponent(url.pathname);
    return pathname.length > 0 ? pathname : null;
  } catch {
    return null;
  }
}

/** Best-effort current working directory of a process. */
export function processCwd(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const output = execFileSync(
        "lsof",
        ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
        { encoding: "utf8", timeout: 500, stdio: ["ignore", "pipe", "ignore"] },
      );
      const line = output.split("\n").find((entry) => entry.startsWith("n"));
      return line ? line.slice(1) : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function clipboardFromOsc52(data: string): string | null {
  const separator = data.indexOf(";");
  if (separator === -1) return null;
  const targets = data.slice(0, separator);
  const payload = data.slice(separator + 1);
  if (payload === "?" || (targets && !/[cps0-7]/.test(targets))) return null;
  if (payload.length > Math.ceil(MAX_CLIPBOARD_BYTES / 3) * 4) return null;
  try {
    return Buffer.from(payload, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function sanitizeTitle(title: string): string {
  return title.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 256);
}

/** Shell per Shepherd's [terminal] settings: `default_shell` or $SHELL, and
 * a login shell on macOS in "auto" mode. */
export function configuredShell(
  defaultShellSetting: string,
  mode: "auto" | "login" | "non_login",
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  if (platform === "win32") return defaultShell();
  const file = defaultShellSetting || env.SHELL || "/bin/sh";
  const login = mode === "login" || (mode === "auto" && platform === "darwin");
  return { file, args: login ? ["-l"] : [] };
}

export function defaultShell(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const file = process.env.ComSpec ?? "powershell.exe";
    return file.toLowerCase().includes("powershell")
      ? { file, args: ["-NoLogo"] }
      : { file, args: [] };
  }
  return { file: process.env.SHELL ?? "/bin/sh", args: ["-l"] };
}

function safeDimension(
  value: number,
  minimum: number,
  maximum: number,
): number {
  const rounded = Math.floor(value);
  if (!Number.isFinite(rounded)) return minimum;
  return Math.min(maximum, Math.max(minimum, rounded));
}

type HeadlessBufferLine = ReturnType<
  HeadlessTerminal["buffer"]["active"]["getLine"]
>;
type HeadlessBufferCell = NonNullable<ReturnType<
  NonNullable<HeadlessBufferLine>["getCell"]
>>;

function styledLine(
  line: NonNullable<HeadlessBufferLine>,
  columns: number,
): TerminalLine {
  const spans: TerminalLine = [];
  let current: TerminalSpan | null = null;
  const cell: HeadlessBufferCell | undefined = undefined;

  for (let x = 0; x < columns; x += 1) {
    const entry = line.getCell(x, cell ?? undefined);
    if (!entry) break;
    if (entry.getWidth() === 0) continue;

    const text = entry.isInvisible() !== 0 || entry.getChars() === ""
      ? " "
      : entry.getChars();
    const span: TerminalSpan = {
      text,
      color: foregroundColor(entry),
      backgroundColor: backgroundColor(entry),
      bold: entry.isBold() !== 0,
      italic: entry.isItalic() !== 0,
      dimColor: entry.isDim() !== 0,
      underline: entry.isUnderline() !== 0,
      inverse: entry.isInverse() !== 0,
      strikethrough: entry.isStrikethrough() !== 0,
    };

    if (current && sameStyle(current, span)) {
      current.text += text;
    } else {
      current = span;
      spans.push(current);
    }
  }

  while (spans.length > 0) {
    const last = spans[spans.length - 1];
    if (!last || last.text.trim().length !== 0) break;
    spans.pop();
  }
  return spans;
}

/** SGR sequence and text for one span (used to replay a screen). */
function spanAnsi(span: TerminalSpan): string {
  const codes = ["0"];
  if (span.bold) codes.push("1");
  if (span.dimColor) codes.push("2");
  if (span.italic) codes.push("3");
  if (span.underline) codes.push("4");
  if (span.inverse) codes.push("7");
  if (span.strikethrough) codes.push("9");
  const rgb = (value: string) => {
    const hex = value.replace("#", "");
    return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(";");
  };
  if (span.color?.startsWith("#")) codes.push(`38;2;${rgb(span.color)}`);
  if (span.backgroundColor?.startsWith("#")) codes.push(`48;2;${rgb(span.backgroundColor)}`);
  return `\x1b[${codes.join(";")}m${span.text}`;
}

function sameStyle(left: TerminalSpan, right: TerminalSpan): boolean {
  return left.color === right.color &&
    left.backgroundColor === right.backgroundColor &&
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.dimColor === right.dimColor &&
    left.underline === right.underline &&
    left.inverse === right.inverse &&
    left.strikethrough === right.strikethrough;
}

function foregroundColor(cell: HeadlessBufferCell): string | undefined {
  if (cell.isFgDefault()) return undefined;
  if (cell.isFgRGB()) return rgbColor(cell.getFgColor());
  return paletteColor(cell.getFgColor());
}

function backgroundColor(cell: HeadlessBufferCell): string | undefined {
  if (cell.isBgDefault()) return undefined;
  if (cell.isBgRGB()) return rgbColor(cell.getBgColor());
  return paletteColor(cell.getBgColor());
}

function rgbColor(value: number): string {
  return `#${Math.max(0, Math.min(0xffffff, value))
    .toString(16)
    .padStart(6, "0")}`;
}

function paletteColor(value: number): string {
  if (value >= 232 && value <= 255) {
    const level = 8 + (value - 232) * 10;
    return rgbColor((level << 16) | (level << 8) | level);
  }
  if (value >= 16 && value < 232) {
    const offset = value - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    const red = levels[Math.floor(offset / 36) % 6] ?? 0;
    const green = levels[Math.floor(offset / 6) % 6] ?? 0;
    const blue = levels[offset % 6] ?? 0;
    return rgbColor((red << 16) | (green << 8) | blue);
  }

  return [
    "#000000", "#800000", "#008000", "#808000",
    "#000080", "#800080", "#008080", "#c0c0c0",
    "#808080", "#ff0000", "#00ff00", "#ffff00",
    "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
  ][Math.max(0, Math.min(15, value))];
}

export function unwrapTerminalLines(
  lines: TerminalLine[],
  wrapped: boolean[],
): TerminalLine[] {
  const result: TerminalLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (wrapped[index] && result.length > 0) {
      const previous = result[result.length - 1];
      if (previous) {
        for (const span of lines[index]) {
          const last = previous[previous.length - 1];
          if (last && sameStyle(last, span)) last.text += span.text;
          else previous.push({ ...span });
        }
      }
    } else {
      result.push([...lines[index]]);
    }
  }
  return result;
}
