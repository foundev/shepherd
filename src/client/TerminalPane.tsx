import { memo } from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";
import { terminalColor, terminalForegroundColor } from "./colors.js";
import { displayWidth, type BorderCell, type PaneFrame } from "./geometry.js";
import { truncateText } from "./chrome.js";
import { StatusBadge, statusBadgeWidth } from "./indicators.js";
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

/** A pane in Shepherd's style: rounded border in the accent colour when
 * focused, the label set into the top edge, terminal rows, and a scrollbar
 * gutter. Rows are memoized by line identity. */
export const TerminalPane = memo(function TerminalPane({
  pane,
  focused,
  width,
  height,
  lines,
  foregroundColor = theme.text,
  label = "",
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
    return cell ? { text: cell.text, color: cell.accent ? theme.brand : theme.border } : null;
  };

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {edges.top && (
        <BorderRow
          cells={edges.top}
          label={label}
          focused={focused}
          status={pane.agent ? pane.status : null}
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
      {edges.bottom && <BorderRow cells={edges.bottom} label="" focused={focused} />}
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

/** A top or bottom border row, grouped into runs by colour, with the
 * label set into it one cell from the left. */
function BorderRow({
  cells,
  label,
  focused,
  status,
}: {
  cells: BorderCell[];
  label: string;
  focused: boolean;
  status?: PaneView["status"] | null;
}) {
  const width = cells.length;
  const compact = width < 24;
  const badgeWidth = status && width >= 8 ? statusBadgeWidth(status, compact) : 0;
  const title = label && width > badgeWidth + 4
    ? ` ${truncateText(label, width - badgeWidth - 4)} `
    : "";
  const runs = (from: BorderCell[]) => {
    const result: Array<{ text: string; accent: boolean }> = [];
    for (const cell of from) {
      const last = result.at(-1);
      if (last && last.accent === cell.accent) last.text += cell.text;
      else result.push({ text: cell.text, accent: cell.accent });
    }
    return result.map((run, index) => (
      <Text key={index} color={run.accent ? theme.brand : theme.border}>{run.text}</Text>
    ));
  };
  if (!title && !badgeWidth) return <Text>{runs(cells)}</Text>;
  const middleStart = 1 + displayWidth(title);
  const badgeStart = width - 1 - badgeWidth;
  return (
    <Text wrap="truncate-end">
      {runs(cells.slice(0, 1))}
      {title && (
        <Text
          color={focused ? theme.panelContrast : theme.subtext}
          backgroundColor={focused ? theme.brand : theme.surfaceRaised}
          bold={focused}
        >
          {title}
        </Text>
      )}
      {runs(cells.slice(middleStart, badgeStart))}
      {badgeWidth > 0 && <StatusBadge status={status!} compact={compact} />}
      {runs(cells.slice(badgeStart + badgeWidth))}
    </Text>
  );
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
