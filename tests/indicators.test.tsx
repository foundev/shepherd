import React from "react";
import { stripVTControlCharacters } from "node:util";
import { Box, Text, renderToString } from "ink";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnimatedIndicator, StatusBadge, statusBadgeSegments } from "../src/client/indicators.js";
import { configureTerminalColors } from "../src/client/colors.js";
import { applyTheme, statusBackground, statusColor, statusForeground } from "../src/client/theme.js";
import { PALETTES } from "../src/client/palettes.js";
import type { AgentStatus } from "../src/types.js";

const statuses: AgentStatus[] = ["blocked", "working", "done", "idle", "unknown"];
const luminance = (hex: string) => {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
};

afterEach(() => { applyTheme("shepherd"); });

describe("native Ink indicators", () => {
  it("keeps distinct status labels and glyphs when colors are disabled", () => {
    const restore = configureTerminalColors({ isTTY: true }, { FORCE_COLOR: "0" });
    try {
      const frame = renderToString(<Box flexDirection="column">
        {statuses.map((status) => <StatusBadge key={status} status={status} />)}
      </Box>);
      for (const label of ["× BLOCKED", "◐ WORKING", "◇ REVIEW", "○ IDLE", "· UNKNOWN"]) {
        expect(frame).toContain(label);
      }
      expect(frame).not.toContain("\x1b[");
    } finally { restore(); }
  });

  it.each(Object.keys(PALETTES).filter((name) => name !== "terminal"))(
    "keeps solid chip text readable in %s", (name) => {
      applyTheme(name);
      for (const status of statuses) {
        const foreground = luminance(statusForeground[status]!);
        const background = luminance(statusColor[status]!);
        expect((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)).toBeGreaterThanOrEqual(4.5);
      }
      expect(new Set(Object.values(statusBackground)).size).toBe(5);
    },
  );

  it("adapts filled badges to custom colors and 256-color output without changing their width", () => {
    const restore = configureTerminalColors({ isTTY: true }, { FORCE_COLOR: "2" });
    try {
      applyTheme("shepherd", { red: "#123456", yellow: "#ffee99" });
      const full = renderToString(<StatusBadge status="blocked" solid />);
      const compact = renderToString(<StatusBadge status="working" compact solid />);
      expect(full).toContain("\x1b[48;5;");
      expect(full).not.toMatch(/\x1b\[(38|48);2;/);
      expect(stripVTControlCharacters(full)).toBe(" × BLOCKED ");
      expect(stripVTControlCharacters(compact)).toBe(" ◐ ");
      expect(statusForeground.blocked).toBe("ansi256(231)");
      expect(statusForeground.working).toBe("ansi256(16)");
    } finally { restore(); }
  });

  it.each([
    ["black", "white"], ["red", "white"], ["green", "white"],
    ["blue", "white"], ["magenta", "white"], ["cyan", "white"],
    ["gray", "black"], ["yellow", "black"], ["white", "black"],
    ["lightred", "black"], ["lightgreen", "black"], ["lightyellow", "black"],
    ["lightblue", "white"], ["lightmagenta", "black"], ["lightcyan", "black"],
  ])("keeps solid status chips legible with the named color %s", (color, foreground) => {
    applyTheme("shepherd", { red: color });
    const [icon] = statusBadgeSegments("blocked", { compact: true, solid: true });
    expect(icon?.color).toBe(foreground);
    expect(icon?.color).not.toBe(icon?.backgroundColor);
  });

  it("keeps terminal-palette badge labels visible, including unknown status", () => {
    applyTheme("terminal");
    for (const status of statuses) {
      for (const segment of statusBadgeSegments(status)) {
        expect(segment.color).not.toBe(segment.backgroundColor);
      }
    }
    expect(statusBackground.unknown).toBe("black");
    expect(statusColor.unknown).toBe("gray");
  });

  it("chooses contrast from effective fallback colors when overrides reset status tokens", () => {
    applyTheme("shepherd", { red: "default", yellow: "reset", teal: "none", green: "transparent", overlay0: "default" });
    expect(statusColor).toMatchObject({ blocked: "red", working: "yellow", done: "cyan", idle: "green", unknown: "gray" });
    expect(statusForeground).toMatchObject({ blocked: "white", working: "black", done: "white", idle: "white", unknown: "black" });
  });

  it("avoids drawing status text on an identical custom surface", () => {
    applyTheme("shepherd", { overlay0: "gray", surface0: "gray" });
    const [, label] = statusBadgeSegments("unknown");
    expect(label?.color).toBe("gray");
    expect(label?.backgroundColor).toBeUndefined();
    expect(statusBackground.unknown).toBe("black");
  });

  it("shares one activity clock, updates only indicator leaves, and stops after unmount", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let parentRenders = 0;
    function Parent() {
      parentRenders += 1;
      return <Box><StatusBadge status="working" animate /><Text><AnimatedIndicator text="◐" /></Text></Box>;
    }
    const instance = render(<Parent />);
    const flush = () => new Promise((resolve) => setTimeout(resolve, 30));
    try {
      await flush();
      expect(vi.getTimerCount()).toBe(1);
      const first = stripVTControlCharacters(instance.lastFrame() ?? "");
      const initialRenders = parentRenders;
      await vi.advanceTimersByTimeAsync(800);
      await flush();
      const next = stripVTControlCharacters(instance.lastFrame() ?? "");
      expect(next).toContain("◓");
      expect(next.length).toBe(first.length);
      expect(parentRenders).toBe(initialRenders);
      instance.unmount();
      await flush();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      instance.unmount();
      vi.useRealTimers();
    }
  });
});
