import { layoutGeometry, layoutSplits, type PaneGeometry, type SplitEdge } from "../server/layout.js";
import type { LayoutNode, Rect } from "../types.js";

/** Sidebar widths when collapsed: Shepherd's compact status rail, or none. */
export const COMPACT_SIDEBAR_WIDTH = 4;

export interface ScreenOptions {
  /** Expanded sidebar width. */
  sidebarWidth: number;
  sidebarState: "expanded" | "compact" | "hidden";
  tabBar: "top" | "bottom" | "none";
  /** At or below this many columns the screen uses the phone layout. */
  mobileThreshold?: number;
  /** Workspace context and shortcut footer on desktop-sized screens. */
  workspaceChrome?: boolean;
}

/** Rows of the phone-width header above the panes. */
export const MOBILE_HEADER_HEIGHT = 2;

/** Absolute screen regions (0-based cells, as SGR mouse reports minus one).
 * The sidebar spans the screen; workspace context, tabs, terminal surfaces,
 * and shortcuts occupy separate rows. Compact layouts reclaim context rows. */
export interface ScreenLayout {
  columns: number;
  rows: number;
  sidebar: Rect;
  tabBar: Rect | null;
  main: Rect;
  modeBar: Rect;
  /** Phone-width layout: no sidebar or tab bar, a status header instead. */
  mobile: boolean;
  /** The phone-width header, when `mobile`. */
  header: Rect | null;
  workspaceHeader: Rect | null;
  footer: Rect | null;
}

export function screenLayout(
  columns: number,
  rows: number,
  options: ScreenOptions = {
    sidebarWidth: 26,
    sidebarState: "expanded",
    tabBar: "top",
  },
): ScreenLayout {
  const safeColumns = Math.max(10, Math.floor(columns));
  const safeRows = Math.max(3, Math.floor(rows));
  const mobile = safeColumns <= (options.mobileThreshold ?? 0);
  if (mobile) {
    // Shepherd's single-column presentation: a two-row status header and the
    // pane surface at full width below it.
    const headerHeight = Math.min(MOBILE_HEADER_HEIGHT, safeRows - 1);
    const main = {
      x: 0,
      y: headerHeight,
      width: safeColumns,
      height: safeRows - headerHeight,
    };
    return {
      columns: safeColumns,
      rows: safeRows,
      sidebar: { x: 0, y: 0, width: 0, height: safeRows },
      tabBar: null,
      main,
      modeBar: { x: 0, y: safeRows - 1, width: safeColumns, height: 1 },
      mobile,
      header: { x: 0, y: 0, width: safeColumns, height: headerHeight },
      workspaceHeader: null,
      footer: null,
    };
  }
  const preferred = options.sidebarState === "hidden"
    ? 0
    : options.sidebarState === "compact"
      ? COMPACT_SIDEBAR_WIDTH
      : options.sidebarWidth;
  const sidebarWidth = Math.max(0, Math.min(safeColumns - 1, preferred));
  const mainX = sidebarWidth;
  const mainWidth = safeColumns - sidebarWidth;
  const workspaceChrome = Boolean(options.workspaceChrome && options.tabBar !== "none" && safeRows >= 24 && mainWidth >= 46);
  const headerHeight = workspaceChrome ? 3 : 0;
  const footerHeight = workspaceChrome ? 1 : 0;
  const tabBarRow = options.tabBar === "none" || safeRows <= 1
    ? null
    : options.tabBar === "bottom"
      ? safeRows - footerHeight - 1
      : headerHeight;
  const surfaceY = headerHeight + (options.tabBar === "top" && tabBarRow !== null ? 1 : 0);
  const surfaceHeight = safeRows - headerHeight - footerHeight - (tabBarRow === null ? 0 : 1);
  const main = { x: mainX, y: surfaceY, width: mainWidth, height: surfaceHeight };
  return {
    columns: safeColumns,
    rows: safeRows,
    sidebar: { x: 0, y: 0, width: sidebarWidth, height: safeRows },
    tabBar: tabBarRow === null
      ? null
      : { x: mainX, y: tabBarRow, width: mainWidth, height: 1 },
    main,
    modeBar: workspaceChrome
      ? { x: mainX, y: safeRows - 1, width: mainWidth, height: 1 }
      : tabBarRow !== null && tabBarRow === safeRows - 1
      ? { x: mainX, y: tabBarRow, width: mainWidth, height: 1 }
      : { x: mainX, y: main.y + main.height - 1, width: mainWidth, height: 1 },
    mobile,
    header: null,
    workspaceHeader: workspaceChrome ? { x: mainX, y: 0, width: mainWidth, height: headerHeight } : null,
    footer: workspaceChrome ? { x: mainX, y: safeRows - 1, width: mainWidth, height: footerHeight } : null,
  };
}

/** Which sides of a pane carry a border line. */
export interface PaneEdges {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
}

export const ALL_EDGES: PaneEdges = { top: true, right: true, bottom: true, left: true };
export const NO_EDGES: PaneEdges = { top: false, right: false, bottom: false, left: false };

export interface PaneChrome {
  /** Shorthand for all four edges; `edges` overrides it. */
  bordered: boolean;
  edges?: PaneEdges;
  /** A one-column scrollbar gutter inside the pane on the right. */
  scrollbar: boolean;
}

/** Shepherd's pane chrome: a square border with the title in its top edge
 * when bordered, and a scrollbar gutter on the right. */
export function paneContentRect(
  rect: Rect,
  chrome: PaneChrome = { bordered: true, scrollbar: false },
): Rect {
  const edges = chrome.edges ?? (chrome.bordered ? ALL_EDGES : NO_EDGES);
  const left = edges.left ? 1 : 0;
  const top = edges.top ? 1 : 0;
  const innerWidth = rect.width - left - (edges.right ? 1 : 0);
  const gutter = chrome.scrollbar && innerWidth > 4 ? 1 : 0;
  return {
    x: rect.x + left,
    y: rect.y + top,
    width: Math.max(1, innerWidth - gutter),
    height: Math.max(1, rect.height - top - (edges.bottom ? 1 : 0)),
  };
}

/** `ui.pane_borders`, `ui.pane_gaps` and `ui.pane_outer_borders`. */
export interface PaneStyle {
  borders: "auto" | "always" | "off";
  gaps: boolean;
  outerBorders: boolean;
}

export const DEFAULT_PANE_STYLE: PaneStyle = {
  borders: "auto",
  gaps: true,
  outerBorders: true,
};

export interface FramedPane extends PaneGeometry {
  edges: PaneEdges;
}

function overlaps(startA: number, lengthA: number, startB: number, lengthB: number): boolean {
  return startA < startB + lengthB && startB < startA + lengthA;
}

/** Applies the pane style to laid-out panes. With gaps every pane keeps
 * its own box (borderless panes give up a cell to leave a blank seam);
 * without gaps a pane drops the edge it shares with the pane to its right
 * or below, so neighbours share one divider line. Without outer borders
 * the edges along the outside of the pane area go. `paneCount` is the
 * tab's pane count, which differs from `panes.length` while zoomed. */
export function framePanes(
  panes: PaneGeometry[],
  style: PaneStyle,
  paneCount = panes.length,
): FramedPane[] {
  const split = paneCount > 1;
  const framed = style.borders !== "off" && (split || style.borders === "always");
  let outerLeft = Infinity;
  let outerTop = Infinity;
  let outerRight = -Infinity;
  let outerBottom = -Infinity;
  for (const { rect } of panes) {
    outerLeft = Math.min(outerLeft, rect.x);
    outerTop = Math.min(outerTop, rect.y);
    outerRight = Math.max(outerRight, rect.x + rect.width);
    outerBottom = Math.max(outerBottom, rect.y + rect.height);
  }
  return panes.map((pane) => {
    const { rect } = pane;
    const hasRight = panes.some((other) =>
      other !== pane &&
      other.rect.x === rect.x + rect.width &&
      overlaps(rect.y, rect.height, other.rect.y, other.rect.height)
    );
    const hasBelow = panes.some((other) =>
      other !== pane &&
      other.rect.y === rect.y + rect.height &&
      overlaps(rect.x, rect.width, other.rect.x, other.rect.width)
    );
    let next = rect;
    if (style.gaps && style.borders === "off" && split) {
      next = {
        ...rect,
        width: hasRight && rect.width > 1 ? rect.width - 1 : rect.width,
        height: hasBelow && rect.height > 1 ? rect.height - 1 : rect.height,
      };
    }
    const edges = framed ? { ...ALL_EDGES } : { ...NO_EDGES };
    if (framed && !style.gaps) {
      edges.right &&= !hasRight;
      edges.bottom &&= !hasBelow;
    }
    if (framed && !style.outerBorders) {
      edges.top &&= rect.y !== outerTop;
      edges.left &&= rect.x !== outerLeft;
      edges.right &&= rect.x + rect.width !== outerRight;
      edges.bottom &&= rect.y + rect.height !== outerBottom;
    }
    return { paneId: pane.paneId, rect: next, edges };
  });
}

/** One cell of a drawn border. `accent` marks lines that belong to the
 * focused pane, including a shared divider beside it. */
export interface BorderCell {
  text: string;
  accent: boolean;
}

/** A pane's border cells: full-width top and bottom rows (corners
 * included) and the left and right columns between them. */
export interface PaneFrame {
  top: BorderCell[] | null;
  bottom: BorderCell[] | null;
  left: BorderCell[] | null;
  right: BorderCell[] | null;
  /** A fallback marker on an existing edge when the focused pane has no title row. */
  focusCue?: { edge: keyof PaneEdges; index: number; text: string };
}

const UP = 1;
const DOWN = 2;
const LEFT = 4;
const RIGHT = 8;

const LINE_GLYPHS: Record<number, string> = {
  [UP]: "│",
  [DOWN]: "│",
  [UP | DOWN]: "│",
  [LEFT]: "─",
  [RIGHT]: "─",
  [LEFT | RIGHT]: "─",
  [DOWN | RIGHT]: "┌",
  [DOWN | LEFT]: "┐",
  [UP | RIGHT]: "└",
  [UP | LEFT]: "┘",
  [UP | DOWN | RIGHT]: "├",
  [UP | DOWN | LEFT]: "┤",
  [LEFT | RIGHT | DOWN]: "┬",
  [LEFT | RIGHT | UP]: "┴",
  [UP | DOWN | LEFT | RIGHT]: "┼",
};

const ROUND_CORNERS: Record<number, string> = {
  [DOWN | RIGHT]: "╭",
  [DOWN | LEFT]: "╮",
  [UP | RIGHT]: "╰",
  [UP | LEFT]: "╯",
};

/** Border glyphs for every framed pane. Each cell records which ways its
 * line runs; where neighbours share a divider the divider's cells also
 * join the lines that meet them, so junctions come out as ┬ ┴ ├ ┤ ┼. */
export function paneFrames(
  panes: FramedPane[],
  splits: SplitEdge[],
  style: PaneStyle,
  focusedPaneId: string | null,
): Map<string, PaneFrame> {
  const lines = new Map<string, number>();
  const key = (x: number, y: number) => `${x},${y}`;
  const at = (x: number, y: number) => lines.get(key(x, y)) ?? 0;
  const mark = (x: number, y: number, bits: number) => {
    lines.set(key(x, y), at(x, y) | bits);
  };
  for (const { rect, edges } of panes) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    const right = rect.x + rect.width - 1;
    const bottom = rect.y + rect.height - 1;
    for (let x = rect.x; x <= right; x += 1) {
      const bits = (x > rect.x ? LEFT : 0) | (x < right ? RIGHT : 0);
      if (edges.top) mark(x, rect.y, bits);
      if (edges.bottom) mark(x, bottom, bits);
    }
    for (let y = rect.y; y <= bottom; y += 1) {
      const bits = (y > rect.y ? UP : 0) | (y < bottom ? DOWN : 0);
      if (edges.left) mark(rect.x, y, bits);
      if (edges.right) mark(right, y, bits);
    }
  }
  if (!style.gaps) {
    for (const split of splits) {
      const vertical = split.direction === "right";
      // Walk the divider, one cell past the split's area so it also
      // meets the border of a pane beyond it.
      for (let along = split.crossStart; along <= split.crossEnd; along += 1) {
        const x = vertical ? split.position : along;
        const y = vertical ? along : split.position;
        if (!lines.has(key(x, y))) continue;
        let bits = 0;
        if (along > split.crossStart) bits |= vertical ? UP : LEFT;
        if (along < split.crossEnd - 1) bits |= vertical ? DOWN : RIGHT;
        if (vertical) {
          if (at(x - 1, y) & (LEFT | RIGHT)) bits |= LEFT;
          if (at(x + 1, y) & (LEFT | RIGHT)) bits |= RIGHT;
        } else {
          if (at(x, y - 1) & (UP | DOWN)) bits |= UP;
          if (at(x, y + 1) & (UP | DOWN)) bits |= DOWN;
        }
        mark(x, y, bits);
      }
    }
  }

  const focused = panes.find((pane) => pane.paneId === focusedPaneId)?.rect ?? null;
  const accent = (x: number, y: number): boolean => {
    if (!focused) return false;
    const right = focused.x + focused.width;
    const bottom = focused.y + focused.height;
    const inRows = y >= focused.y && y < bottom;
    const inColumns = x >= focused.x && x < right;
    if (
      (inRows && (x === focused.x || x === right - 1)) ||
      (inColumns && (y === focused.y || y === bottom - 1))
    ) {
      return true;
    }
    // A shared divider (in the neighbour's rect) also lights up.
    if (style.gaps) return false;
    return (inRows && x === right) || (inColumns && y === bottom) ||
      (x === right && y === bottom);
  };
  const cell = (x: number, y: number): BorderCell => ({
    text: (style.gaps ? ROUND_CORNERS[at(x, y)] : undefined) ?? LINE_GLYPHS[at(x, y)] ?? " ",
    accent: accent(x, y),
  });

  const frames = new Map<string, PaneFrame>();
  for (const { paneId, rect, edges } of panes) {
    const right = rect.x + rect.width - 1;
    const bottom = rect.y + rect.height - 1;
    const firstRow = rect.y + (edges.top ? 1 : 0);
    const lastRow = bottom - (edges.bottom ? 1 : 0);
    const row = (y: number) =>
      Array.from({ length: Math.max(0, rect.width) }, (_, index) => cell(rect.x + index, y));
    const column = (x: number) =>
      Array.from({ length: Math.max(0, lastRow - firstRow + 1) }, (_, index) =>
        cell(x, firstRow + index));
    frames.set(paneId, {
      top: edges.top ? row(rect.y) : null,
      bottom: edges.bottom ? row(bottom) : null,
      left: edges.left ? column(rect.x) : null,
      right: edges.right ? column(right) : null,
    });
  }
  const focusedFrame = focusedPaneId ? frames.get(focusedPaneId) : undefined;
  if (focused && focusedFrame && !focusedFrame.top) {
    // Prefer an edge owned by the focused pane. Arrows point into it so a
    // shared divider still distinguishes focus on either side of the line.
    if (focusedFrame.left?.length) focusedFrame.focusCue = { edge: "left", index: 0, text: "▸" };
    else if (focusedFrame.right?.length) focusedFrame.focusCue = { edge: "right", index: 0, text: "◂" };
    else if (focusedFrame.bottom?.length) focusedFrame.focusCue = { edge: "bottom", index: 0, text: "↑" };
    else {
      // Without outer borders or gaps, the neighbour owns the only divider.
      const neighbour = panes.find(({ rect, edges }) => edges.left &&
        rect.x === focused.x + focused.width && overlaps(rect.y, rect.height, focused.y, focused.height));
      if (neighbour) {
        const frame = frames.get(neighbour.paneId)!;
        const firstRow = neighbour.rect.y + (neighbour.edges.top ? 1 : 0);
        const index = Math.max(0, focused.y - firstRow);
        if (frame.left?.[index]) frame.focusCue = { edge: "left", index, text: "◂" };
      } else {
        const below = panes.find(({ rect, edges }) => edges.top &&
          rect.y === focused.y + focused.height && overlaps(rect.x, rect.width, focused.x, focused.width));
        if (below) {
          const frame = frames.get(below.paneId)!;
          frame.focusCue = { edge: "top", index: Math.max(0, focused.x - below.rect.x), text: "↑" };
        }
      }
    }
  }
  return frames;
}

export interface LayoutGeometry {
  panes: PaneGeometry[];
  splits: SplitEdge[];
}

export function computeLayout(node: LayoutNode | null, main: Rect): LayoutGeometry {
  if (!node) return { panes: [], splits: [] };
  return {
    panes: layoutGeometry(node, main),
    splits: layoutSplits(node, main),
  };
}

export function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x &&
    x < rect.x + rect.width &&
    y >= rect.y &&
    y < rect.y + rect.height;
}

export function paneAt(
  panes: PaneGeometry[],
  x: number,
  y: number,
): PaneGeometry | null {
  return panes.find((entry) => contains(entry.rect, x, y)) ?? null;
}

/** The cell inside a pane's terminal content under a screen position,
 * clamped to the content area. */
export function contentCell(
  pane: PaneGeometry,
  x: number,
  y: number,
  chrome?: PaneChrome,
): { col: number; row: number; inside: boolean } {
  const content = paneContentRect(pane.rect, chrome);
  const col = Math.max(0, Math.min(content.width - 1, x - content.x));
  const row = Math.max(0, Math.min(content.height - 1, y - content.y));
  return { col, row, inside: contains(content, x, y) };
}

/** A split border under a screen position. With gaps it is either of the
 * facing borders of the two panes beside the split (or, borderless, the
 * blank seam left of it); without gaps it is the one shared divider, and
 * borderless panes without gaps leave nothing to grab. */
export function splitAt(
  splits: SplitEdge[],
  x: number,
  y: number,
  style: PaneStyle = DEFAULT_PANE_STYLE,
): SplitEdge | null {
  const bordered = style.borders !== "off";
  if (!bordered && !style.gaps) return null;
  return splits.find((edge) => {
    const axis = edge.direction === "right" ? x : y;
    const cross = edge.direction === "right" ? y : x;
    const onSeam = bordered && style.gaps
      ? axis === edge.position - 1 || axis === edge.position
      : bordered
        ? axis === edge.position
        : axis === edge.position - 1 && edge.position > edge.origin;
    return onSeam && cross >= edge.crossStart && cross < edge.crossEnd;
  }) ?? null;
}

/** Positions of tab or workspace labels laid out left to right with one
 * cell of padding before the first and a gap between labels. */
export function labelRegions(
  labels: Array<{ id: string; label: string }>,
  start = 1,
  gap = 1,
): Array<{ id: string; start: number; end: number }> {
  const regions: Array<{ id: string; start: number; end: number }> = [];
  let cursor = start;
  for (const entry of labels) {
    const width = displayWidth(entry.label);
    regions.push({ id: entry.id, start: cursor, end: cursor + width });
    cursor += width + gap;
  }
  return regions;
}

export function regionAt(
  regions: Array<{ id: string; start: number; end: number }>,
  x: number,
): string | null {
  return regions.find((region) => x >= region.start && x < region.end)?.id ??
    null;
}

export function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    width += code >= 0x1100 && isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd);
}
