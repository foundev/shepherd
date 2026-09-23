import type { LayoutNode, Rect, SplitDirection } from "../types.js";

export function paneLayout(paneId: string): LayoutNode {
  return { kind: "pane", paneId };
}

export function paneIds(node: LayoutNode): string[] {
  if (node.kind === "pane") return [node.paneId];
  return [...paneIds(node.first), ...paneIds(node.second)];
}

export function splitPane(
  node: LayoutNode,
  targetPaneId: string,
  newPaneId: string,
  direction: SplitDirection,
  ratio = 0.5,
): LayoutNode {
  if (node.kind === "pane") {
    if (node.paneId !== targetPaneId) return node;
    return {
      kind: "split",
      direction,
      ratio: clampRatio(ratio),
      first: paneLayout(targetPaneId),
      second: paneLayout(newPaneId),
    };
  }

  return {
    ...node,
    first: splitPane(node.first, targetPaneId, newPaneId, direction, ratio),
    second: splitPane(node.second, targetPaneId, newPaneId, direction, ratio),
  };
}

export function removePane(
  node: LayoutNode,
  paneId: string,
): LayoutNode | null {
  if (node.kind === "pane") return node.paneId === paneId ? null : node;

  const first = removePane(node.first, paneId);
  const second = removePane(node.second, paneId);
  if (first && second) return { ...node, first, second };
  return first ?? second;
}

export function swapPaneIds(
  node: LayoutNode,
  leftPaneId: string,
  rightPaneId: string,
): LayoutNode {
  if (node.kind === "pane") {
    if (node.paneId === leftPaneId) return { ...node, paneId: rightPaneId };
    if (node.paneId === rightPaneId) return { ...node, paneId: leftPaneId };
    return node;
  }
  return {
    ...node,
    first: swapPaneIds(node.first, leftPaneId, rightPaneId),
    second: swapPaneIds(node.second, leftPaneId, rightPaneId),
  };
}

export function resizePaneRatio(
  node: LayoutNode,
  targetPaneId: string,
  delta: number,
): LayoutNode {
  if (node.kind === "pane") return node;

  const firstContains = paneIds(node.first).includes(targetPaneId);
  const secondContains = paneIds(node.second).includes(targetPaneId);
  const direction = firstContains ? 1 : secondContains ? -1 : 0;
  return {
    ...node,
    ratio: direction === 0
      ? node.ratio
      : clampRatio(node.ratio + direction * delta),
    first: resizePaneRatio(node.first, targetPaneId, delta),
    second: resizePaneRatio(node.second, targetPaneId, delta),
  };
}

export interface PaneGeometry {
  paneId: string;
  rect: Rect;
}

export function layoutGeometry(
  node: LayoutNode,
  rect: Rect,
): PaneGeometry[] {
  if (node.kind === "pane") return [{ paneId: node.paneId, rect }];
  const [first, second] = splitRects(node, rect);
  return [
    ...layoutGeometry(node.first, first),
    ...layoutGeometry(node.second, second),
  ];
}

export interface SplitEdge {
  /** First pane of the split's first child; resizing it moves this edge. */
  paneId: string;
  direction: SplitDirection;
  /** Column (right) or row (down) where the second child starts. */
  position: number;
  /** Width (right) or height (down) of the split's whole area. */
  span: number;
  /** Start of the split area on the split axis. */
  origin: number;
  crossStart: number;
  crossEnd: number;
  /** Path from the root to this split (false = first child). */
  path: boolean[];
  ratio: number;
}

export function layoutSplits(
  node: LayoutNode,
  rect: Rect,
  path: boolean[] = [],
): SplitEdge[] {
  if (node.kind === "pane") return [];
  const [first, second] = splitRects(node, rect);
  const right = node.direction === "right";
  return [
    {
      paneId: paneIds(node.first)[0] ?? "",
      direction: node.direction,
      position: right ? second.x : second.y,
      span: right ? rect.width : rect.height,
      origin: right ? rect.x : rect.y,
      crossStart: right ? rect.y : rect.x,
      crossEnd: right ? rect.y + rect.height : rect.x + rect.width,
      path,
      ratio: node.ratio,
    },
    ...layoutSplits(node.first, first, [...path, false]),
    ...layoutSplits(node.second, second, [...path, true]),
  ];
}

export type NavDirection = "left" | "right" | "up" | "down";

/** Sets the ratio of the split at `path` (false = first child). */
export function setRatioAt(
  node: LayoutNode,
  path: boolean[],
  ratio: number,
): LayoutNode {
  if (node.kind === "pane") return node;
  if (path.length === 0) return { ...node, ratio: clampRatio(ratio) };
  const [head, ...rest] = path;
  return head
    ? { ...node, second: setRatioAt(node.second, rest, ratio) }
    : { ...node, first: setRatioAt(node.first, rest, ratio) };
}

/** The nearest pane in a direction, preferring the closest edge, then the
 * most overlap, then the closest centre (Shepherd's rule). */
export function paneInDirection(
  panes: PaneGeometry[],
  paneId: string,
  direction: NavDirection,
): string | null {
  const focused = panes.find((pane) => pane.paneId === paneId)?.rect;
  if (!focused) return null;
  const horizontal = direction === "left" || direction === "right";
  let best: { id: string; key: number[] } | null = null;
  panes.forEach((pane, index) => {
    if (pane.paneId === paneId) return;
    const r = pane.rect;
    const beside = direction === "left"
      ? r.x + r.width <= focused.x
      : direction === "right"
        ? r.x >= focused.x + focused.width
        : direction === "up"
          ? r.y + r.height <= focused.y
          : r.y >= focused.y + focused.height;
    const overlap = horizontal
      ? rangeOverlap(r.y, r.height, focused.y, focused.height)
      : rangeOverlap(r.x, r.width, focused.x, focused.width);
    if (!beside || overlap <= 0) return;
    const edge = direction === "left"
      ? focused.x - (r.x + r.width)
      : direction === "right"
        ? r.x - (focused.x + focused.width)
        : direction === "up"
          ? focused.y - (r.y + r.height)
          : r.y - (focused.y + focused.height);
    const center = horizontal
      ? Math.abs((2 * r.y + r.height) - (2 * focused.y + focused.height))
      : Math.abs((2 * r.x + r.width) - (2 * focused.x + focused.width));
    const key = [edge, -overlap, center, index];
    if (!best || compareKeys(key, best.key) < 0) best = { id: pane.paneId, key };
  });
  return (best as { id: string } | null)?.id ?? null;
}

/** Moves the border nearest the pane's edge in `direction` by `delta` of
 * its split (right/down grow the split's first side). Falls back to the
 * opposite edge when the pane has no border on the requested side. */
export function resizeInDirection(
  node: LayoutNode,
  rect: Rect,
  paneId: string,
  direction: NavDirection,
  delta: number,
): LayoutNode {
  const pane = layoutGeometry(node, rect).find((entry) => entry.paneId === paneId);
  if (!pane) return node;
  const splits = layoutSplits(node, rect);
  const opposite: Record<NavDirection, NavDirection> = {
    left: "right",
    right: "left",
    up: "down",
    down: "up",
  };
  const split = nearestSplit(splits, pane.rect, direction) ??
    nearestSplit(splits, pane.rect, opposite[direction]);
  if (!split) return node;
  const grows = direction === "right" || direction === "down";
  return setRatioAt(node, split.path, split.ratio + (grows ? delta : -delta));
}

function nearestSplit(
  splits: SplitEdge[],
  focused: Rect,
  direction: NavDirection,
): SplitEdge | null {
  const horizontal = direction === "left" || direction === "right";
  const distance = (split: SplitEdge) => Math.abs(
    split.position - (direction === "left"
      ? focused.x
      : direction === "right"
        ? focused.x + focused.width
        : direction === "up"
          ? focused.y
          : focused.y + focused.height),
  );
  return splits
    .filter((split) => (split.direction === "right") === horizontal)
    .filter((split) => horizontal
      ? split.crossStart < focused.y + focused.height && split.crossEnd > focused.y
      : split.crossStart < focused.x + focused.width && split.crossEnd > focused.x)
    .filter((split) => distance(split) <= 1)
    .sort((a, b) => distance(a) - distance(b))[0] ?? null;
}

function rangeOverlap(aStart: number, aLength: number, bStart: number, bLength: number): number {
  return Math.min(aStart + aLength, bStart + bLength) - Math.max(aStart, bStart);
}

function compareKeys(left: number[], right: number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const MIN_PANE_WIDTH = 5;
const MIN_PANE_HEIGHT = 4;

/** Divides a split's area between its children. Both children keep a
 * minimum size when there is room for it. */
function splitRects(
  node: Extract<LayoutNode, { kind: "split" }>,
  rect: Rect,
): [Rect, Rect] {
  const ratio = clampRatio(node.ratio);
  if (node.direction === "right") {
    const firstWidth = clampSize(
      Math.round(rect.width * ratio),
      rect.width,
      MIN_PANE_WIDTH,
    );
    return [
      { ...rect, width: firstWidth },
      { ...rect, x: rect.x + firstWidth, width: rect.width - firstWidth },
    ];
  }
  const firstHeight = clampSize(
    Math.round(rect.height * ratio),
    rect.height,
    MIN_PANE_HEIGHT,
  );
  return [
    { ...rect, height: firstHeight },
    { ...rect, y: rect.y + firstHeight, height: rect.height - firstHeight },
  ];
}

function clampSize(value: number, total: number, minimum: number): number {
  if (total < minimum * 2) return Math.max(1, Math.floor(total / 2));
  return Math.min(total - minimum, Math.max(minimum, value));
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(0.9, Math.max(0.1, value));
}
