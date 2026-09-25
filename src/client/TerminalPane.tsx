import { memo } from "react";
import { Box, Text } from "ink";
import { statusColor, theme } from "./theme.js";
import { terminalColor, terminalForegroundColor } from "./colors.js";
import { displayWidth, type BorderCell, type PaneFrame } from "./geometry.js";
import { truncateText } from "./chrome.js";
import { deskLane } from "../agentDesk.js";
import {
  selectedColumns,
  type TextSelection,
} from "./surfaces.js";
import type { PaneView, TerminalLine, TerminalSpan } from "../types.js";

interface TerminalPaneProps {
  pane: PaneView;
  focused: boolean;
  width: number;
  height: number;
  lines: TerminalLine[];
  /** Default text color, passed explicitly so theme changes invalidate memoized rows. */
  foregroundColor?: string;
  /** Border label; empty for none (labels appear when explicitly set). */
  label?: string;
  /** Show the agent identity next to a distinct pane title. */
  showAgentLabel?: boolean;
  bordered?: boolean;
  /** Border cells from `paneFrames` (shared dividers and junctions);
   * without it a bordered pane draws its own box. */
  frame?: PaneFrame;
  /** Scrollback position for the scrollbar gutter, or null for none. */
  scrollbar?: { offsetFromBottom: number; maxOffsetFromBottom: number } | null;
  selection?: TextSelection;
  /** Absolute buffer line of the first visible row. */
  viewTop?: number;
  /** Copy mode cursor (absolute line). */
  copyCursor?: { line: number; col: number };
}

/** A pane with a quiet title surface and a single focus cue. Chrome uses the
 * existing border cells, leaving the terminal's dimensions unchanged. */
export const TerminalPane = memo(function TerminalPane({
  pane,
  focused,
  width,
  height,
  lines,
  foregroundColor = theme.text,
  label = "",
  showAgentLabel = true,
  bordered = true,
  frame,
  scrollbar = null,
  selection,
  viewTop = 0,
  copyCursor,
}: TerminalPaneProps) {
  const edges = frame ?? (bordered ? boxFrame(width, height, focused) : NO_FRAME);
  const innerWidth = Math.max(1, width - (edges.left ? 1 : 0) - (edges.right ? 1 : 0));
  const gutter = scrollbar !== null && innerWidth > 4 ? 1 : 0;
  const contentCols = Math.max(1, innerWidth - gutter);
  const contentRows = Math.max(1, height - (edges.top ? 1 : 0) - (edges.bottom ? 1 : 0));
  const thumb = gutter && scrollbar
    ? scrollbarThumb(scrollbar, contentRows)
    : null;
  const side = (cells: BorderCell[] | null, index: number) => {
    const cell = cells?.[index];
    const focusCue = focused && !edges.top && index === 0 && cells === (edges.left ?? edges.right);
    return cell ? { text: cell.text, color: focusCue ? theme.brand : theme.border } : null;
  };

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {edges.top && (
        <PaneHeader
          cells={edges.top}
          label={label}
          showAgentLabel={showAgentLabel}
          focused={focused}
          pane={pane}
        />
      )}
      {Array.from({ length: contentRows }, (_, index) => (
        <TerminalRow
          key={index}
          line={lines[index]}
          foregroundColor={foregroundColor}
          selected={selection
            ? selectedColumns(selection, viewTop + index, contentCols)
            : null}
          cursorCol={copyCursor?.line === viewTop + index ? copyCursor.col : null}
          width={contentCols}
          left={side(edges.left, index)}
          right={side(edges.right, index)}
          gutter={gutter
            ? thumb && index >= thumb[0] && index < thumb[1]
              ? { text: focused ? "▐" : "▕", color: focused ? theme.brand : theme.overlay1 }
              : thumb
                ? { text: "▕", color: focused ? theme.muted : theme.surfaceDim }
                : { text: " " }
            : null}
        />
      ))}
      {edges.bottom && <PaneFooter cells={edges.bottom} pane={pane} />}
    </Box>
  );
});

const NO_FRAME: PaneFrame = { top: null, bottom: null, left: null, right: null };

/** A standalone rounded box, used when no shared-divider frame is given. */
function boxFrame(width: number, height: number, accent: boolean): PaneFrame {
  const edge = (left: string, fill: string, right: string): BorderCell[] =>
    Array.from({ length: Math.max(0, width) }, (_, index) => ({
      text: index === 0 ? left : index === width - 1 ? right : fill,
      accent,
    }));
  const side = Array.from({ length: Math.max(0, height - 2) }, () => ({ text: "│", accent }));
  return {
    top: edge("╭", "─", "╮"),
    bottom: edge("╰", "─", "╯"),
    left: side,
    right: side,
  };
}

interface BorderRun {
  text: string;
  color?: string;
  bold?: boolean;
}

/** Slots exclude corners and shared junctions, which must survive the title. */
function borderSlots(cells: BorderCell[]): Array<[number, number]> {
  const slots: Array<[number, number]> = [];
  let start = 1;
  for (let index = 1; index < cells.length; index += 1) {
    if (index < cells.length - 1 && /[─ ]/.test(cells[index]!.text)) continue;
    if (index > start) slots.push([start, index]);
    start = index + 1;
  }
  return slots;
}

function putBorderText(cells: BorderRun[], start: number, text: string, color?: string, bold?: boolean) {
  const width = displayWidth(text);
  if (!width) return;
  cells[start] = { text, color, bold };
  for (let index = start + 1; index < start + width; index += 1) cells[index] = { text: "" };
}

function BorderLine({ cells, background }: { cells: BorderRun[]; background?: string }) {
  const runs: BorderRun[] = [];
  for (const cell of cells) {
    if (!cell.text) continue;
    const previous = runs.at(-1);
    if (previous && previous.color === cell.color && previous.bold === cell.bold) previous.text += cell.text;
    else runs.push({ ...cell });
  }
  return (
    <Text backgroundColor={background} wrap="truncate-end">
      {runs.map((run, index) => (
        <Text key={index} color={run.color} backgroundColor={background} bold={run.bold}>{run.text}</Text>
      ))}
    </Text>
  );
}

function PaneHeader({
  cells,
  label,
  showAgentLabel,
  focused,
  pane,
}: {
  cells: BorderCell[];
  label: string;
  showAgentLabel: boolean;
  focused: boolean;
  pane: PaneView;
}) {
  const slots = borderSlots(cells);
  const row: BorderRun[] = cells.map((cell, index) => ({
    text: index > 0 && index < cells.length - 1 && cell.text === "─" ? " " : cell.text,
    color: theme.border,
  }));
  const first = slots[0];
  const last = slots.at(-1);
  if (!first || !last) return <BorderLine cells={row} background={theme.surfaceRaised} />;

  const lane = deskLane(pane);
  const state = {
    blocked: { glyph: "!", label: "Needs you", color: statusColor.blocked },
    working: { glyph: "◐", label: "Working", color: statusColor.working },
    review: { glyph: "◇", label: "Review", color: statusColor.done },
    ready: { glyph: "○", label: "Ready", color: theme.subtext },
    unknown: { glyph: "·", label: "Unknown", color: theme.muted },
  }[lane];
  const hasStatus = Boolean(pane.agent || pane.task);
  const longStatus = `${state.glyph} ${state.label} `;
  const status = hasStatus && last[1] - last[0] >= 3
    ? cells.length >= 48 && last[1] - last[0] >= displayWidth(longStatus) + 4 ? longStatus : `${state.glyph} `
    : "";
  const statusStart = last[1] - displayWidth(status);
  if (status) putBorderText(row, statusStart, status, state.color);

  const titleEnd = first === last ? statusStart - (status ? 1 : 0) : first[1];
  let cursor = first[0];
  if (cursor < titleEnd) {
    putBorderText(row, cursor, focused ? "▎" : " ", focused ? theme.brand : theme.border, focused);
    cursor += 1;
  }
  if (cursor < titleEnd) cursor += 1;
  // An empty label still means no pane label, including when agent labels are disabled.
  if (label && cursor < titleEnd) {
    const identity = pane.displayAgent || pane.agent || "";
    const title = label === identity ? pane.task?.title || label : label;
    const showIdentity = showAgentLabel && identity && title !== identity &&
      titleEnd - cursor >= displayWidth(identity) + 3 + displayWidth(title);
    if (showIdentity) {
      putBorderText(row, cursor, identity, theme.text, true);
      cursor += displayWidth(identity);
      putBorderText(row, cursor, " · ", theme.muted);
      cursor += 3;
    }
    putBorderText(row, cursor, truncateText(title, titleEnd - cursor), theme.text, !showIdentity);
  }
  return <BorderLine cells={row} background={theme.surfaceRaised} />;
}

/** Path and checks use only the bottom edge, and only reported checks get a result. */
function PaneFooter({ cells, pane }: { cells: BorderCell[]; pane: PaneView }) {
  const row: BorderRun[] = cells.map((cell) => ({ text: cell.text, color: theme.border }));
  const slots = borderSlots(cells);
  const first = slots[0];
  const last = slots.at(-1);
  if (cells.length < 44 || !first || !last) return <BorderLine cells={row} />;
  const checks = pane.task?.checkStatus;
  const check = checks === "passed" ? { label: "✓ checks passed", color: theme.success }
    : checks === "failed" ? { label: "× checks failed", color: theme.danger }
      : checks === "running" ? { label: "◐ checking", color: theme.warning } : null;
  const checkText = check ? ` ${check.label} ` : "";
  const checkWidth = displayWidth(checkText);
  const showCheck = check && last[1] - last[0] >= checkWidth;
  const checkStart = showCheck ? last[1] - checkWidth : last[1];
  if (showCheck) putBorderText(row, checkStart, checkText, check.color);
  const available = Math.max(0, (first === last ? checkStart : first[1]) - first[0] - 3);
  if (pane.cwd && available >= 8) {
    let path = pane.cwd;
    if (displayWidth(path) > available) {
      let tail = "";
      for (const character of [...path].reverse()) {
        if (displayWidth(character + tail) > available - 1) break;
        tail = character + tail;
      }
      path = `…${tail}`;
    }
    putBorderText(row, first[0], ` ${path} `, theme.muted);
  }
  return <BorderLine cells={row} />;
}

/** Thumb rows [start, end) for the scrollbar, or null with no scrollback. */
export function scrollbarThumb(
  scroll: { offsetFromBottom: number; maxOffsetFromBottom: number },
  track: number,
): [number, number] | null {
  if (scroll.maxOffsetFromBottom <= 0 || track <= 0) return null;
  const total = scroll.maxOffsetFromBottom + track;
  const length = Math.max(1, Math.round((track * track) / total));
  const top = scroll.maxOffsetFromBottom - scroll.offsetFromBottom;
  const start = Math.min(
    track - length,
    Math.round((top / Math.max(1, scroll.maxOffsetFromBottom)) * (track - length)),
  );
  return [start, start + length];
}

const EMPTY_LINE: TerminalLine = [];

/** One terminal row, padded to the content width so the right border and
 * scrollbar stay in their column. */
const TerminalRow = memo(function TerminalRow({
  line = EMPTY_LINE,
  foregroundColor,
  selected,
  cursorCol,
  width,
  left,
  right,
  gutter,
}: {
  line?: TerminalLine;
  foregroundColor?: string;
  selected: [number, number] | null;
  cursorCol: number | null;
  width: number;
  left: { text: string; color: string } | null;
  right: { text: string; color: string } | null;
  gutter: { text: string; color?: string } | null;
}) {
  let spans = selected ? highlight(line, selected, width) : line;
  if (cursorCol !== null) {
    spans = highlight(spans, [cursorCol, cursorCol + 1], width);
  }
  const clipped = clip(spans, width);
  const used = clipped.reduce((total, span) => total + displayWidth(span.text), 0);
  return (
    <Text wrap="truncate-end" color={foregroundColor}>
      {left ? <Text color={left.color}>{left.text}</Text> : null}
      {clipped.map((span, index) => (
        <Text
          key={index}
          color={terminalForegroundColor(span.color, span.bold)}
          backgroundColor={terminalColor(span.backgroundColor)}
          bold={span.bold}
          italic={span.italic}
          dimColor={span.dimColor}
          underline={span.underline}
          inverse={span.inverse}
          strikethrough={span.strikethrough}
        >
          {span.text}
        </Text>
      ))}
      {used < width ? " ".repeat(width - used) : null}
      {gutter ? <Text color={gutter.color}>{gutter.text}</Text> : null}
      {right ? <Text color={right.color}>{right.text}</Text> : null}
    </Text>
  );
}, (previous, next) =>
  previous.line === next.line &&
  previous.foregroundColor === next.foregroundColor &&
  previous.width === next.width &&
  previous.cursorCol === next.cursorCol &&
  previous.left?.text === next.left?.text &&
  previous.left?.color === next.left?.color &&
  previous.right?.text === next.right?.text &&
  previous.right?.color === next.right?.color &&
  previous.gutter?.text === next.gutter?.text &&
  previous.gutter?.color === next.gutter?.color &&
  previous.selected?.[0] === next.selected?.[0] &&
  previous.selected?.[1] === next.selected?.[1]);

/** Cuts spans to `width` display columns. */
function clip(spans: TerminalLine, width: number): TerminalLine {
  const result: TerminalSpan[] = [];
  let used = 0;
  for (const span of spans) {
    const spanWidth = displayWidth(span.text);
    if (used + spanWidth <= width) {
      result.push(span);
      used += spanWidth;
      continue;
    }
    let text = "";
    for (const character of span.text) {
      if (used + displayWidth(text + character) > width) break;
      text += character;
    }
    if (text) result.push({ ...span, text });
    break;
  }
  return result;
}

/** Inverts the cells in [from, to), padding the line so a selection past
 * the end of the text is still visible. */
export function highlight(
  line: TerminalLine,
  [from, to]: [number, number],
  width: number,
): TerminalLine {
  const result: TerminalSpan[] = [];
  let column = 0;
  const push = (span: TerminalSpan, text: string, inverse: boolean) => {
    if (!text) return;
    result.push({ ...span, text, inverse: inverse ? !span.inverse : span.inverse });
  };
  for (const span of line) {
    const characters = [...span.text];
    const start = column;
    const end = column + characters.length;
    const a = Math.max(start, Math.min(end, from));
    const b = Math.max(start, Math.min(end, to));
    push(span, characters.slice(0, a - start).join(""), false);
    push(span, characters.slice(a - start, b - start).join(""), true);
    push(span, characters.slice(b - start).join(""), false);
    column = end;
  }
  const padEnd = Math.min(width, to);
  if (padEnd > column) {
    const gap = Math.max(0, from - column);
    if (gap > 0) result.push({ text: " ".repeat(gap) });
    result.push({
      text: " ".repeat(padEnd - Math.max(column, from)),
      inverse: true,
    });
  }
  return result;
}
