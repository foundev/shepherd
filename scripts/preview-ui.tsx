/** Render the real Ink application against an in-memory demo connection.
 *
 * node --import tsx scripts/preview-ui.tsx --svg docs/ui-preview.svg
 * node --import tsx scripts/preview-ui.tsx --width 58 --height 32 --svg /tmp/mobile.svg
 *
 * ANSI is written to stdout; SVG is a cell-for-cell capture of that same frame.
 * No daemon, terminal subprocess, user config, or external service is used.
 */
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { parseArgs } from "node:util";
import React from "react";
import { render } from "ink";
import xterm from "@xterm/headless";
import type { IBufferCell } from "@xterm/headless";
import { App, type AppConnection } from "../src/client/App.js";
import { configureTerminalColors } from "../src/client/colors.js";
import { canonicalThemeName, theme } from "../src/client/theme.js";
import { defaultLoadedConfig } from "../src/config/model.js";
import { updateTask } from "../src/server/tasks.js";
import type {
  AgentTaskPatch, EventFrame, PaneView, ShepherdRequest, StateView,
  SurfaceFrame, TabView, TerminalLine,
} from "../src/types.js";

const { values } = parseArgs({ options: {
  width: { type: "string", default: "140" },
  height: { type: "string", default: "40" },
  theme: { type: "string", default: "shepherd" },
  svg: { type: "string" },
  switcher: { type: "boolean", default: false },
  help: { type: "boolean", default: false },
} });

function dimension(value: string, name: string, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}

async function main(): Promise<void> {
  const width = dimension(values.width, "width", 24, 240);
  const height = dimension(values.height, "height", 16, 100);
  const themeName = canonicalThemeName(values.theme);
  if (!themeName) throw new Error(`Unknown theme: ${values.theme}`);
  const config = defaultLoadedConfig();
  config.config.theme.name = themeName;
  config.config.theme.auto_switch = false;
  config.config.ui.window_title = "";
  config.config.ui.sound.enabled = false;
  config.config.ui.tab_bar_right = [];
  const mobile = width <= config.config.ui.mobile_width_threshold;
  if (values.switcher && !mobile) throw new Error("--switcher requires a phone-width preview (64 columns or fewer)");
  const stdout = new FrameOutput(width, height);
  const stdin = new PreviewInput();
  const connection = new PreviewConnection(demoState(mobile));
  const restoreColors = configureTerminalColors({ isTTY: true }, { FORCE_COLOR: "3" });
  const app = render(<App connection={connection} config={config} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  let frame: string;
  try {
    await waitForFrame(stdout, "CLAUDE");
    if (values.switcher) {
      stdin.push("\x02w");
      await waitForFrame(stdout, "+ new workspace");
    }
    frame = stdout.frame.split("\n").slice(0, height).join("\n");
    if (values.svg) await writeFile(values.svg, await frameSvg(frame, width, height, themeName));
  } finally {
    app.unmount();
    app.cleanup();
    stdin.destroy();
    connection.close();
    restoreColors();
  }
  process.stdout.write(`${frame}\x1b[0m\n`);
}

class FrameOutput extends EventEmitter {
  readonly isTTY = true;
  frame = "";
  constructor(readonly columns: number, readonly rows: number) { super(); }
  write(data: string | Uint8Array): boolean {
    const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    // Host control sequences (appearance queries, cursor changes) are not frames.
    if (text.includes("\n")) this.frame = text;
    return true;
  }
}

class PreviewInput extends Readable {
  readonly isTTY = true;
  _read(): void {}
  setRawMode(): this { return this; }
  ref(): this { return this; }
  unref(): this { return this; }
}

async function waitForFrame(output: FrameOutput, text: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (output.frame.includes(text)) return;
  }
  throw new Error(`Ink preview did not settle on a frame containing ${JSON.stringify(text)}`);
}

const FIXTURE_TIME = Date.parse("2026-09-25T09:30:00.000Z");

function demoState(mobile: boolean): StateView {
  const pane = (id: string, agent: string, status: PaneView["status"], task: AgentTaskPatch): PaneView => ({
    id, title: task.title ?? agent, command: agent, cwd: "/work/atlas", agent, status,
    displayAgent: agent === "codex" ? "Codex" : "Claude",
    metadataTitle: task.title,
    exitCode: null, updatedAt: new Date(FIXTURE_TIME).toISOString(),
    signal: { source: "integration", confidence: "reported", reason: task.summary ?? "", observedAt: FIXTURE_TIME, changedAt: FIXTURE_TIME, expiresAt: null },
    task: updateTask(null, task, "preview", undefined, FIXTURE_TIME),
  });
  const release: TabView = {
    id: "release", name: "release", zoomedPaneId: mobile ? "migration" : null,
    layout: { kind: "split", direction: "right", ratio: 0.5,
      first: { kind: "pane", paneId: "migration" },
      second: { kind: "split", direction: "down", ratio: 0.5,
        first: { kind: "pane", paneId: "search" },
        second: { kind: "pane", paneId: "checkout" } },
    },
  };
  const docs: TabView = { id: "docs", name: "documentation", layout: { kind: "pane", paneId: "docs" } };
  return {
    protocolVersion: 1, session: "preview", serverPid: 1, stateVersion: 1,
    activeWorkspaceId: "atlas", activeTabId: release.id, focusedPaneId: "migration",
    tabs: [release], plugins: [], machines: [],
    workspaces: [
      { id: "atlas", name: "atlas", rootPath: "/work/atlas", activeTabId: release.id, tabs: [release],
        git: { repoName: "atlas", repoKey: "/work/atlas", repoRoot: "/work/atlas", checkoutPath: "/work/atlas", linked: false, branch: "feat/launch", ahead: 3, behind: 0 } },
      { id: "platform", name: "platform", rootPath: "/work/platform", activeTabId: docs.id, tabs: [docs],
        git: { repoName: "platform", repoKey: "/work/platform", repoRoot: "/work/platform", checkoutPath: "/work/platform", linked: false, branch: "main", ahead: 0, behind: 0 } },
    ],
    panes: [
      pane("migration", "claude", "blocked", { title: "Database migration", summary: "Migration is ready. Waiting for approval.", blocker: "Approve migration", nextAction: "Review SQL and approve", checkStatus: "passed", checkSummary: "18 migration checks passed" }),
      pane("search", "codex", "working", { title: "Search performance", summary: "Adding coverage for the new search index.", nextAction: "Run integration tests", checkStatus: "running", checkSummary: "Running search tests" }),
      pane("checkout", "claude", "done", { title: "Checkout flow", summary: "Implementation complete. Ready for review.", nextAction: "Review checkout changes", checkStatus: "passed", checkSummary: "24 checks passed", review: "requested" }),
      { ...pane("docs", "codex", "idle", { title: "API documentation", summary: "Documentation is up to date.", checkStatus: "passed", review: "reviewed" }), cwd: "/work/platform" },
    ],
  };
}

class PreviewConnection implements AppConnection {
  private handler?: (event: EventFrame) => void;
  constructor(private readonly state: StateView) {}
  async request(request: ShepherdRequest): Promise<unknown> {
    if (request.type === "state.get") return structuredClone(this.state);
    if (request.type === "surface.subscribe") {
      queueMicrotask(() => {
        for (const pane of request.panes) {
          const lines = terminalFixture(pane.paneId);
          const data: SurfaceFrame = {
            paneId: pane.paneId, revision: 1, full: true, cols: pane.cols, rows: pane.rows,
            lines: Object.fromEntries(lines.slice(0, pane.rows).map((line, index) => [index, line])),
            cursor: { x: 0, y: 0, visible: false, shape: "block", blink: false },
            title: "", scroll: { offsetFromBottom: 0, maxOffsetFromBottom: 0 },
            modes: { applicationCursorKeys: false, bracketedPaste: false, mouseTracking: "none", sendFocus: false, alternateScreen: false },
          };
          this.handler?.({ event: "pane.surface", data: { ...data }, emittedAt: new Date(FIXTURE_TIME).toISOString() });
        }
      });
      return { accepted: true };
    }
    if (request.type === "events.subscribe") return { accepted: true };
    throw new Error(`Unexpected request in a read-only preview: ${request.type}`);
  }
  setEventHandler(handler: ((event: EventFrame) => void) | undefined): void { this.handler = handler; }
  close(): void { this.handler = undefined; }
}

function terminalFixture(id: string): TerminalLine[] {
  const text = (value = "", color = theme.text, bold = false): TerminalLine => [{ text: value, color, bold }];
  const command = (value: string): TerminalLine => [
    { text: "  > ", color: theme.brand, bold: true }, { text: value, color: theme.text },
  ];
  if (id === "migration") return [
    text(), text("  CLAUDE  /  atlas", theme.brand, true),
    text("  Database migration", theme.text, true), text(),
    text("  Add team-level roles and permissions."),
    text("  Keep existing member access unchanged."), text(),
    text("  Plan", theme.subtext, true),
    text("  ✓ Inspect the existing schema", theme.success),
    text("  ✓ Add reversible migration", theme.success),
    text("  ✓ Validate existing role assignments", theme.success),
    text("  ◇ Waiting for your approval", theme.warning), text(),
    text("  migrations/024_team_roles.sql", theme.cyan),
    text("  + CREATE TABLE team_roles (", theme.success),
    text("  +   team_id UUID REFERENCES teams(id),", theme.success),
    text("  +   user_id UUID REFERENCES users(id),", theme.success),
    text("  +   role TEXT NOT NULL DEFAULT 'member'", theme.success),
    text("  + );", theme.success), text(),
    text("  Checks", theme.subtext, true),
    text("  ✓ 18 migration checks passed", theme.success),
    text("  ✓ Rollback verified", theme.success), text(),
    text("  APPROVAL REQUESTED", theme.danger, true),
    text("  Apply this migration to the local database?"),
    text("  The production database is unaffected.", theme.muted), text(),
    text("  [y] approve    [n] revise", theme.warning, true), text(),
    command("Awaiting your decision…"),
  ];
  if (id === "search") return [
    text(), text("  CODEX  /  atlas", theme.brand, true),
    text("  Search performance", theme.text, true), text(),
    text("  Replacing the full scan with an index."),
    text("  ✓ Query planner updated", theme.success),
    text("  ✓ Pagination preserved", theme.success), text(),
    command("npm test -- search"),
    text("  PASS  search/query.test.ts", theme.success),
    text("  PASS  search/ranking.test.ts", theme.success),
    text("  ◐ Running integration coverage…", theme.warning), text(),
    text("  12 checks passed · 3 running", theme.muted),
  ];
  if (id === "checkout") return [
    text(), text("  CLAUDE  /  atlas", theme.brand, true),
    text("  Checkout flow", theme.text, true), text(),
    text("  Ready for your review.", theme.cyan, true),
    text("  Added validation and retry handling."), text(),
    text("  src/checkout/form.tsx       +42  -8", theme.success),
    text("  src/checkout/submit.ts      +28  -5", theme.success),
    text("  tests/checkout.test.ts      +64", theme.success), text(),
    text("  ✓ 24 checks passed", theme.success),
    text("  ✓ Types and formatting clean", theme.success), text(),
    text("  Review the changes when you are ready.", theme.muted),
  ];
  return [text("  API documentation is up to date.", theme.success)];
}

const ANSI_PALETTE = [
  "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
  "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
];

function paletteColor(index: number): string {
  if (index < 16) return ANSI_PALETTE[index]!;
  if (index >= 232) return `#${(8 + (index - 232) * 10).toString(16).padStart(2, "0").repeat(3)}`;
  const cube = [0, 95, 135, 175, 215, 255];
  const value = index - 16;
  return `#${[Math.floor(value / 36), Math.floor(value / 6) % 6, value % 6]
    .map((channel) => cube[channel]!.toString(16).padStart(2, "0")).join("")}`;
}

function cellColor(cell: IBufferCell, foreground: boolean, fallback: string): string {
  const value = foreground ? cell.getFgColor() : cell.getBgColor();
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) return `#${value.toString(16).padStart(6, "0")}`;
  if (foreground ? cell.isFgPalette() : cell.isBgPalette()) return paletteColor(value);
  return fallback;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

/** Decode Ink's ANSI through the same terminal model used by real panes. */
async function frameSvg(frame: string, columns: number, rows: number, themeName: string): Promise<string> {
  const terminal = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 0 });
  try {
    await new Promise<void>((resolve) => terminal.write(frame.replace(/\n/g, "\r\n"), resolve));
    const cellWidth = 9;
    const cellHeight = 20;
    const background = theme.background?.startsWith("#") ? theme.background : "#101722";
    const foreground = theme.text?.startsWith("#") ? theme.text : "#e9f0f2";
    const backgrounds: string[] = [];
    const glyphs: string[] = [];
    for (let row = 0; row < rows; row += 1) {
      const line = terminal.buffer.active.getLine(row);
      for (let column = 0; column < columns; column += 1) {
        const cell = line?.getCell(column);
        if (!cell || cell.getWidth() === 0) continue;
        let fg = cellColor(cell, true, foreground);
        let bg = cellColor(cell, false, background);
        if (cell.isInverse()) [fg, bg] = [bg, fg];
        const x = column * cellWidth;
        const y = row * cellHeight;
        const width = cell.getWidth() * cellWidth;
        if (bg !== background) backgrounds.push(`<rect x="${x}" y="${y}" width="${width}" height="${cellHeight}" fill="${bg}"/>`);
        const characters = cell.getChars();
        if (!characters || characters === " " || cell.isInvisible()) continue;
        const decoration = [cell.isUnderline() ? "underline" : "", cell.isStrikethrough() ? "line-through" : ""].filter(Boolean).join(" ");
        glyphs.push(`<text x="${x}" y="${y + 15}" fill="${fg}"${cell.isBold() ? ' font-weight="700"' : ""}${cell.isItalic() ? ' font-style="italic"' : ""}${cell.isDim() ? ' opacity="0.5"' : ""}${decoration ? ` text-decoration="${decoration}"` : ""}>${escapeXml(characters)}</text>`);
      }
    }
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<svg xmlns="http://www.w3.org/2000/svg" width="${columns * cellWidth}" height="${rows * cellHeight}" viewBox="0 0 ${columns * cellWidth} ${rows * cellHeight}" role="img" aria-labelledby="title desc">`,
      `<title id="title">Shepherd native Ink interface · ${escapeXml(themeName)}</title>`,
      `<desc id="desc">Actual ${columns} by ${rows} terminal-cell capture of the Shepherd React and Ink application with demonstration agent data. Regenerate with scripts/preview-ui.tsx.</desc>`,
      `<rect width="100%" height="100%" fill="${background}"/>`,
      ...backgrounds,
      '<g font-family="DejaVu Sans Mono, monospace" font-size="15" xml:space="preserve">',
      ...glyphs,
      "</g></svg>", "",
    ].join("\n");
  } finally {
    terminal.dispose();
  }
}

if (values.help) {
  console.log("Usage: node --import tsx scripts/preview-ui.tsx [--width 140] [--height 40] [--theme shepherd] [--svg path.svg] [--switcher]\n\nWrites a native Ink ANSI frame to stdout. --svg exports the same frame as SVG.\nUse --width 58 for the phone layout; --switcher opens its workspace switcher.");
} else {
  await main();
}
