import React from "react";
import chalk from "chalk";
import { Box, Text, renderToString } from "ink";
import { describe, expect, it } from "vitest";
import {
  configureTerminalColors,
  terminalColor,
  terminalColorLevel,
} from "../src/client/colors.js";
import { applyTheme, theme } from "../src/client/theme.js";
import { PALETTES } from "../src/client/palettes.js";
import { TerminalPane } from "../src/client/TerminalPane.js";
import type { PaneView } from "../src/types.js";

const wsl = { TERM: "xterm-256color", WT_SESSION: "windows-terminal", COLORTERM: "" };

describe("host color capabilities", () => {
  it("recognizes Windows Terminal under WSL without COLORTERM", () => {
    expect(terminalColorLevel(wsl, true, 2)).toBe(3);
    expect(terminalColorLevel({ TERM: "xterm-256color" }, true, 2)).toBe(2);
    expect(terminalColorLevel({ COLORTERM: "24bit" }, true, 2)).toBe(3);
    expect(terminalColorLevel({ COLORTERM: "truecolor" }, true, 2)).toBe(3);
  });

  it.each([
    { TMUX: "/tmp/tmux/default" }, { STY: "screen" },
    { TERM: "screen-256color" }, { TERM: "tmux-256color" },
    { SSH_TTY: "/dev/pts/0" }, { SSH_CONNECTION: "remote" },
  ])("does not infer intermediary capabilities from WT_SESSION: %j", (env) => {
    expect(terminalColorLevel({ ...wsl, ...env }, true, 2)).toBe(2);
  });

  it("respects explicit preferences and noninteractive output", () => {
    for (const level of [0, 1, 2, 3] as const) {
      expect(terminalColorLevel({ ...wsl, FORCE_COLOR: String(level) }, true, 3)).toBe(level);
    }
    expect(terminalColorLevel({ ...wsl, FORCE_COLOR: "false" }, true, 3)).toBe(0);
    expect(terminalColorLevel({ ...wsl, NO_COLOR: "1" }, true, 2)).toBe(0);
    expect(terminalColorLevel({ ...wsl, NODE_DISABLE_COLORS: "1" }, true, 2)).toBe(0);
    expect(terminalColorLevel({ ...wsl, NO_COLOR: "1", FORCE_COLOR: "3" }, true, 2)).toBe(3);
    expect(terminalColorLevel({ ...wsl, TERM: "dumb" }, true, 2)).toBe(0);
    expect(terminalColorLevel(wsl, false, 2)).toBe(0);
  });
});

describe("limited color rendering", () => {
  it("uses dark grayscale surfaces instead of saturated blue or medium gray", () => {
    expect(terminalColor("#101722", 2)).toBe("ansi256(234)"); // #1c1c1c
    expect(terminalColor("#0b111b", 2)).toBe("ansi256(233)"); // #121212
    expect(terminalColor("#1b2936", 2)).toBe("ansi256(235)"); // #262626
    expect(terminalColor("#1c3040", 2)).toBe("ansi256(236)"); // #303030
    expect(terminalColor("#101722", 3)).toBe("#101722");
    expect(terminalColor("cyan", 2)).toBe("cyan");
    expect(terminalColor(undefined, 2)).toBeUndefined();
  });

  it("preserves exact cube and grayscale values instead of rounding them twice", () => {
    expect(terminalColor("#005f87", 2)).toBe("ansi256(24)");
    expect(terminalColor("#808080", 2)).toBe("ansi256(244)");
    expect(terminalColor("#ffffff", 2)).toBe("ansi256(231)");
  });

  it("renders both themed chrome and pane RGB backgrounds through Ink in 256 colors", () => {
    const restore = configureTerminalColors({ isTTY: true }, { FORCE_COLOR: "2" });
    try {
      applyTheme("shepherd");
      const frame = renderToString(
        <Box flexDirection="column" backgroundColor={theme.background}>
          <Text color={theme.text} backgroundColor={theme.surfaceRaised}>SHEPHERD</Text>
          <TerminalPane pane={pane} focused width={20} height={1} bordered={false}
            lines={[[{ text: "shell", color: "#e9f0f2", backgroundColor: "#101722" }]]} />
        </Box>,
        { columns: 20 },
      );
      expect(frame).toContain("SHEPHERD");
      expect(frame).toContain("shell");
      expect(frame).toContain("\x1b[48;5;234m");
      expect(frame).toContain("\x1b[48;5;235m");
      expect(frame).toContain("\x1b[38;5;255m");
      expect(frame).not.toContain("\x1b[48;5;17m");
      expect(frame).not.toMatch(/\x1b\[(38|48);2;/);

      const paneFrame = renderToString(
        <TerminalPane pane={pane} focused width={20} height={1} bordered={false}
          lines={[[{ text: "shell", backgroundColor: "#101722" }]]} />,
      );
      expect(paneFrame).toContain("\x1b[48;5;234m");
    } finally {
      restore();
      applyTheme("shepherd");
    }
  });

  it("keeps light themes light and applies custom colors and terminal defaults", () => {
    const restore = configureTerminalColors({ isTTY: true }, { FORCE_COLOR: "2" });
    try {
      applyTheme("shepherd-day");
      expect(theme.background).toBe("ansi256(231)");
      expect(theme.text).toBe("ansi256(235)");
      applyTheme("shepherd", { panel_bg: "#005f87", sidebar_bg: "default" }, "#808080");
      expect(theme.background).toBe("ansi256(24)");
      expect(theme.sidebarBg).toBeUndefined();
      expect(theme.brand).toBe("ansi256(244)");
      applyTheme("terminal");
      expect(theme.background).toBeUndefined();
      expect(theme.brand).toBe("blue");
    } finally {
      restore();
      applyTheme("shepherd");
    }
  });

  it("renders full RGB on WSL and restores renderer state without changing the environment", () => {
    const previousLevel = chalk.level;
    const env = { ...wsl };
    const restore = configureTerminalColors({ isTTY: true }, env);
    try {
      applyTheme("shepherd");
      expect(theme.background).toBe(PALETTES.shepherd!.panel_bg);
      const frame = renderToString(<Text backgroundColor={theme.background}>RGB</Text>);
      expect(frame).toContain("\x1b[48;2;16;23;34m");
      expect(env).toEqual(wsl);
    } finally { restore(); }
    expect(chalk.level).toBe(previousLevel);
  });
});

describe("shell colors", () => {
  it.each(["1", "2", "3"])("uses host ANSI colors and bright bold prompts at color level %s", (level) => {
    const restore = configureTerminalColors({ isTTY: true }, { FORCE_COLOR: level });
    try {
      applyTheme("shepherd");
      const frame = renderToString(
        <TerminalPane pane={pane} focused width={40} height={1} bordered={false}
          lines={[[
            { text: "user", color: "green", bold: true },
            { text: ":" },
            { text: "dir", color: "blue", bold: true },
            { text: " normal", color: "blue" },
            { text: " bright", color: "blueBright" },
            { text: " background", color: "white", backgroundColor: "blue", bold: true },
          ]]} />,
        { columns: 40 },
      );
      expect(frame).toContain("\x1b[92m");
      expect(frame).toContain("\x1b[94m");
      expect(frame).toContain("\x1b[34m");
      expect(frame).toContain("\x1b[44m");
      expect(frame).not.toContain("\x1b[104m");
    } finally {
      restore();
      applyTheme("shepherd");
    }
  });

  it.each(["shepherd", "shepherd-day", "terminal"])("renders default text with %s and preserves explicit app colors", (name) => {
    const restore = configureTerminalColors({ isTTY: true }, { FORCE_COLOR: "3" });
    try {
      applyTheme(name);
      const lines = [[{ text: "plain text" }]];
      const frame = renderToString(
        <Box backgroundColor={theme.background}>
          <TerminalPane pane={pane} focused width={20} height={1} bordered={false} lines={lines} />
        </Box>,
      );
      const foreground = PALETTES[name]!.text;
      expect(frame).toContain("plain text");
      if (foreground) {
        const rgb = [1, 3, 5].map((offset) => Number.parseInt(foreground.slice(offset, offset + 2), 16));
        expect(frame).toContain(`\x1b[38;2;${rgb.join(";")}m`);
      } else {
        expect(frame).not.toMatch(/\x1b\[38;/);
      }

      const rgbFrame = renderToString(
        <TerminalPane pane={pane} focused width={20} height={1} bordered={false}
          lines={[[{ text: "app colors", color: "#000080", backgroundColor: "#123456", bold: true }]]} />,
      );
      expect(rgbFrame).toContain("\x1b[38;2;0;0;128m");
      expect(rgbFrame).toContain("\x1b[48;2;18;52;86m");
    } finally {
      restore();
      applyTheme("shepherd");
    }
  });
});

const pane: PaneView = {
  id: "p1", title: "shell", command: null, cwd: "/tmp", agent: null,
  status: "idle", exitCode: null, updatedAt: "2026-09-24T00:00:00Z",
};
