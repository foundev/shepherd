import { describe, expect, it } from "vitest";
import {
  computeLayout,
  framePanes,
  paneContentRect,
  paneFrames,
  screenLayout,
  splitAt,
  type PaneFrame,
  type PaneStyle,
} from "../src/client/geometry.js";
import { revealScroll, switcherScreen } from "../src/client/mobile.js";
import type { LayoutNode } from "../src/types.js";

// p1 on the left, p2 over p3 on the right.
const TREE: LayoutNode = {
  kind: "split",
  direction: "right",
  ratio: 0.5,
  first: { kind: "pane", paneId: "p1" },
  second: {
    kind: "split",
    direction: "down",
    ratio: 0.5,
    first: { kind: "pane", paneId: "p2" },
    second: { kind: "pane", paneId: "p3" },
  },
};
const AREA = { x: 0, y: 0, width: 20, height: 8 };

const style = (overrides: Partial<PaneStyle>): PaneStyle => ({
  borders: "auto",
  gaps: true,
  outerBorders: true,
  ...overrides,
});

/** Draws every pane's frame onto a character grid. */
function draw(frames: Map<string, PaneFrame>, panes: ReturnType<typeof framePanes>): string[] {
  const grid = Array.from({ length: AREA.height }, () => Array.from({ length: AREA.width }, () => " "));
  for (const pane of panes) {
    const frame = frames.get(pane.paneId)!;
    const { x, y, width, height } = pane.rect;
    frame.top?.forEach((cell, index) => { grid[y]![x + index] = cell.text; });
    frame.bottom?.forEach((cell, index) => { grid[y + height - 1]![x + index] = cell.text; });
    const first = y + (frame.top ? 1 : 0);
    frame.left?.forEach((cell, index) => { grid[first + index]![x] = cell.text; });
    frame.right?.forEach((cell, index) => { grid[first + index]![x + width - 1] = cell.text; });
  }
  return grid.map((row) => row.join(""));
}

describe("phone-width screen layout", () => {
  it("reserves the desktop workspace header and footer outside terminal cells", () => {
    const options = { sidebarWidth: 32, sidebarState: "expanded" as const, workspaceChrome: true };
    const top = screenLayout(140, 40, { ...options, tabBar: "top" });
    expect(top.workspaceHeader).toEqual({ x: 32, y: 0, width: 108, height: 3 });
    expect(top.tabBar).toEqual({ x: 32, y: 3, width: 108, height: 1 });
    expect(top.main).toEqual({ x: 32, y: 4, width: 108, height: 35 });
    expect(top.footer).toEqual({ x: 32, y: 39, width: 108, height: 1 });
    expect(top.modeBar).toEqual(top.footer);
    const bottom = screenLayout(140, 40, { ...options, tabBar: "bottom" });
    expect(bottom.main).toEqual({ x: 32, y: 3, width: 108, height: 35 });
    expect(bottom.tabBar?.y).toBe(38);
    expect(bottom.footer?.y).toBe(39);
    for (const compact of [
      screenLayout(58, 40, { ...options, tabBar: "top", mobileThreshold: 64 }),
      screenLayout(140, 12, { ...options, tabBar: "top" }),
      screenLayout(140, 23, { ...options, tabBar: "top" }),
      screenLayout(65, 30, { ...options, tabBar: "top" }),
      screenLayout(140, 40, { ...options, tabBar: "none" }),
    ]) {
      expect(compact.workspaceHeader).toBeNull();
      expect(compact.footer).toBeNull();
    }
    expect(screenLayout(65, 16, { ...options, tabBar: "top" }).main.height).toBe(15);
  });

  it("puts a two-row header over full-width panes at or below the threshold", () => {
    const options = {
      sidebarWidth: 26,
      sidebarState: "expanded" as const,
      tabBar: "top" as const,
      mobileThreshold: 64,
    };
    const phone = screenLayout(64, 30, options);
    expect(phone.mobile).toBe(true);
    expect(phone.header).toEqual({ x: 0, y: 0, width: 64, height: 2 });
    expect(phone.sidebar.width).toBe(0);
    expect(phone.tabBar).toBeNull();
    expect(phone.main).toEqual({ x: 0, y: 2, width: 64, height: 28 });

    const desktop = screenLayout(65, 30, options);
    expect(desktop.mobile).toBe(false);
    expect(desktop.header).toBeNull();
    expect(desktop.main.x).toBe(26);
  });

  it("keeps the highlighted switcher row in view", () => {
    expect(revealScroll({ start: 20, end: 22 }, 0, 10)).toBe(12);
    expect(revealScroll({ start: 2, end: 4 }, 5, 10)).toBe(2);
    expect(revealScroll({ start: 6, end: 8 }, 5, 10)).toBe(5);
    expect(revealScroll(undefined, 5, 10)).toBe(5);
  });

  it("clamps the switcher scroll and draws a scrollbar when the list overflows", () => {
    const items = Array.from({ length: 30 }, (_, index) => ({
      segments: [{ text: `row ${index}` }],
    }));
    const screen = switcherScreen({ items, workspaceRows: new Map() }, {
      width: 30,
      height: 10,
      scroll: 99,
    });
    expect(screen.maxScroll).toBe(23);
    expect(screen.scroll).toBe(23);
    expect(screen.rows).toHaveLength(10);
    expect(screen.rows[3]!.segments[0]!.text).toMatch(/[│▌]/);
    expect(screen.rows[3]!.segments[1]!.text).toBe("row 23");
  });
});

describe("pane framing", () => {
  const layout = computeLayout(TREE, AREA);

  it("keeps separate boxes with gaps", () => {
    const panes = framePanes(layout.panes, style({}));
    expect(panes.every((pane) => Object.values(pane.edges).every(Boolean))).toBe(true);
    expect(draw(paneFrames(panes, layout.splits, style({}), null), panes)).toEqual([
      "╭────────╮╭────────╮",
      "│        ││        │",
      "│        ││        │",
      "│        │╰────────╯",
      "│        │╭────────╮",
      "│        ││        │",
      "│        ││        │",
      "╰────────╯╰────────╯",
    ]);
  });

  it("shares one divider between neighbours without gaps", () => {
    const gapless = style({ gaps: false });
    const panes = framePanes(layout.panes, gapless);
    expect(panes.map((pane) => pane.edges)).toEqual([
      { top: true, right: false, bottom: true, left: true },
      { top: true, right: true, bottom: false, left: true },
      { top: true, right: true, bottom: true, left: true },
    ]);
    expect(draw(paneFrames(panes, layout.splits, gapless, null), panes)).toEqual([
      "┌─────────┬────────┐",
      "│         │        │",
      "│         │        │",
      "│         │        │",
      "│         ├────────┤",
      "│         │        │",
      "│         │        │",
      "└─────────┴────────┘",
    ]);
    // Content loses only the edges a pane keeps.
    expect(paneContentRect(panes[0]!.rect, { bordered: false, edges: panes[0]!.edges, scrollbar: false }))
      .toEqual({ x: 1, y: 1, width: 9, height: 6 });
  });

  it("draws only internal dividers without outer borders", () => {
    const tmux = style({ gaps: false, outerBorders: false });
    const panes = framePanes(layout.panes, tmux);
    expect(draw(paneFrames(panes, layout.splits, tmux, null), panes)).toEqual([
      "          │         ",
      "          │         ",
      "          │         ",
      "          │         ",
      "          ├─────────",
      "          │         ",
      "          │         ",
      "          │         ",
    ]);
  });

  it("lights the focused pane's edges and the divider beside it", () => {
    const gapless = style({ gaps: false });
    const panes = framePanes(layout.panes, gapless);
    const frames = paneFrames(panes, layout.splits, gapless, "p1");
    // p2's left edge is the divider next to p1.
    expect(frames.get("p2")!.left!.every((cell) => cell.accent)).toBe(true);
    expect(frames.get("p2")!.top![0]!.accent).toBe(true);
    expect(frames.get("p2")!.top![1]!.accent).toBe(false);
    expect(frames.get("p3")!.right!.some((cell) => cell.accent)).toBe(false);
  });

  it("leaves a blank seam between borderless panes with gaps", () => {
    const panes = framePanes(layout.panes, style({ borders: "off" }));
    expect(panes.map((pane) => pane.rect)).toEqual([
      { x: 0, y: 0, width: 9, height: 8 },
      { x: 10, y: 0, width: 10, height: 3 },
      { x: 10, y: 4, width: 10, height: 4 },
    ]);
    expect(framePanes(layout.panes, style({ borders: "off", gaps: false }))[0]!.rect)
      .toEqual({ x: 0, y: 0, width: 10, height: 8 });
  });

  it("frames a lone pane only with borders always and outer borders on", () => {
    const lone = computeLayout({ kind: "pane", paneId: "p1" }, AREA).panes;
    expect(framePanes(lone, style({ borders: "always" }))[0]!.edges.top).toBe(true);
    expect(framePanes(lone, style({ borders: "always", outerBorders: false }))[0]!.edges)
      .toEqual({ top: false, right: false, bottom: false, left: false });
    expect(framePanes(lone, style({}))[0]!.edges.top).toBe(false);
    // A zoomed pane keeps the framing of its split tab.
    expect(framePanes(lone, style({}), 3)[0]!.edges.top).toBe(true);
  });

  it("hit-tests the split seam that each style draws", () => {
    const { splits } = layout;
    expect(splitAt(splits, 9, 2, style({}))?.direction).toBe("right");
    expect(splitAt(splits, 10, 2, style({}))?.direction).toBe("right");
    expect(splitAt(splits, 9, 2, style({ gaps: false }))).toBeNull();
    expect(splitAt(splits, 10, 2, style({ gaps: false }))?.direction).toBe("right");
    expect(splitAt(splits, 15, 4, style({ gaps: false }))?.direction).toBe("down");
    expect(splitAt(splits, 15, 3, style({ gaps: false }))).toBeNull();
    expect(splitAt(splits, 9, 2, style({ borders: "off" }))?.direction).toBe("right");
    expect(splitAt(splits, 10, 2, style({ borders: "off" }))).toBeNull();
    expect(splitAt(splits, 10, 2, style({ borders: "off", gaps: false }))).toBeNull();
  });
});
