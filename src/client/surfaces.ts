import type {
  CursorView,
  PaneModesView,
  SurfaceFrame,
  TerminalLine,
} from "../types.js";

export interface PaneSurface {
  lines: TerminalLine[];
  cursor: CursorView | null;
  title: string;
  cols: number;
  rows: number;
  revision: number;
  scroll: { offsetFromBottom: number; maxOffsetFromBottom: number };
  modes: PaneModesView;
}

/** Plain PageUp/PageDown scroll history instead of reaching the app when
 * the pane looks like a shell prompt (Shepherd's rule). */
export function isShellLike(modes: PaneModesView | undefined): boolean {
  if (!modes) return true;
  return !modes.alternateScreen &&
    modes.mouseTracking === "none" &&
    (!modes.applicationCursorKeys || modes.bracketedPaste);
}

/** Applies a pushed frame to the rows a client holds. Unchanged rows keep
 * their identity so memoized row components skip re-rendering. */
export function applySurfaceFrame(
  previous: PaneSurface | undefined,
  frame: SurfaceFrame,
): PaneSurface {
  const lines = frame.full || !previous
    ? Array.from({ length: frame.rows }, () => [] as TerminalLine)
    : previous.lines.slice(0, frame.rows);
  while (lines.length < frame.rows) lines.push([]);
  for (const [index, line] of Object.entries(frame.lines)) {
    lines[Number(index)] = line;
  }
  return {
    lines,
    cursor: frame.cursor,
    title: frame.title,
    cols: frame.cols,
    rows: frame.rows,
    revision: frame.revision,
    scroll: frame.scroll,
    modes: frame.modes,
  };
}

/** Absolute buffer line shown at the top of a pane's view. */
export function viewTop(surface: PaneSurface | undefined): number {
  if (!surface) return 0;
  return surface.scroll.maxOffsetFromBottom - surface.scroll.offsetFromBottom;
}

/** `row` is an absolute buffer line, so a selection stays on its text while
 * the pane scrolls or produces output. */
export interface CellPosition {
  col: number;
  row: number;
}

export interface TextSelection {
  paneId: string;
  anchor: CellPosition;
  head: CellPosition;
  mode: "char" | "word" | "line";
}

export function orderedSelection(selection: TextSelection): {
  start: CellPosition;
  end: CellPosition;
} {
  const { anchor, head } = selection;
  const anchorFirst = anchor.row < head.row ||
    (anchor.row === head.row && anchor.col <= head.col);
  return anchorFirst
    ? { start: anchor, end: head }
    : { start: head, end: anchor };
}

export function lineText(line: TerminalLine): string {
  return line.map((span) => span.text).join("");
}

/** Columns [start, end) of a row covered by a selection, or null. */
export function selectedColumns(
  selection: TextSelection,
  row: number,
  width: number,
): [number, number] | null {
  const { start, end } = orderedSelection(selection);
  if (row < start.row || row > end.row) return null;
  if (selection.mode === "line") return [0, width];
  const from = row === start.row ? start.col : 0;
  const to = row === end.row ? end.col + 1 : width;
  return from < to ? [from, to] : null;
}

/** Text covered by a selection, trimming trailing blanks on each row.
 * `lineAt` returns the plain text of an absolute buffer line. */
export function selectionText(
  selection: TextSelection,
  lineAt: (row: number) => string,
): string {
  const { start, end } = orderedSelection(selection);
  const rows: string[] = [];
  for (let row = start.row; row <= end.row; row += 1) {
    const text = [...lineAt(row)];
    const range = selectedColumns(selection, row, Math.max(text.length, 1));
    if (!range) continue;
    rows.push(text.slice(range[0], range[1]).join("").replace(/\s+$/, ""));
  }
  return rows.join("\n");
}

const WORD_DELIMITERS = /[\s"'`()[\]{}<>|,;:]/;

/** Expands a cell to the word around it (or the run of delimiters). */
export function wordAt(line: TerminalLine, col: number): [number, number] {
  const text = [...lineText(line)];
  if (col >= text.length) return [col, col];
  const isDelimiter = (character: string | undefined) =>
    character === undefined || WORD_DELIMITERS.test(character);
  const target = isDelimiter(text[col]);
  let start = col;
  let end = col;
  while (start > 0 && isDelimiter(text[start - 1]) === target) start -= 1;
  while (end < text.length - 1 && isDelimiter(text[end + 1]) === target) {
    end += 1;
  }
  return [start, end];
}
