/** Keyboard copy mode motions (vi style, as in Shepherd's copy mode). Lines are
 * absolute buffer line indexes; `text(line)` returns a line's plain text. */

export interface CopyPosition {
  line: number;
  col: number;
}

export type CopyMotion =
  | "left"
  | "right"
  | "up"
  | "down"
  | "word_next"
  | "word_prev"
  | "word_end"
  | "bigword_next"
  | "bigword_prev"
  | "bigword_end"
  | "line_start"
  | "first_nonblank"
  | "line_end"
  | "top"
  | "bottom"
  | "paragraph_prev"
  | "paragraph_next"
  | "page_up"
  | "page_down"
  | "half_page_up"
  | "half_page_down";

export interface CopyBuffer {
  text: (line: number) => string;
  /** Number of lines in the buffer. */
  total: number;
  /** Visible rows, for paging. */
  page: number;
}

export function moveCopyCursor(
  position: CopyPosition,
  motion: CopyMotion,
  buffer: CopyBuffer,
): CopyPosition {
  const last = Math.max(0, buffer.total - 1);
  const clampLine = (line: number) => Math.max(0, Math.min(last, line));
  const lineLength = (line: number) => [...buffer.text(line)].length;
  const clampCol = (line: number, col: number) =>
    Math.max(0, Math.min(Math.max(0, lineLength(line) - 1), col));
  const vertical = (delta: number): CopyPosition => {
    const line = clampLine(position.line + delta);
    return { line, col: clampCol(line, position.col) };
  };

  switch (motion) {
    case "left":
      return { line: position.line, col: Math.max(0, position.col - 1) };
    case "right":
      return { line: position.line, col: clampCol(position.line, position.col + 1) };
    case "up":
      return vertical(-1);
    case "down":
      return vertical(1);
    case "page_up":
      return vertical(-Math.max(1, buffer.page - 2));
    case "page_down":
      return vertical(Math.max(1, buffer.page - 2));
    case "half_page_up":
      return vertical(-Math.max(1, Math.floor(buffer.page / 2)));
    case "half_page_down":
      return vertical(Math.max(1, Math.floor(buffer.page / 2)));
    case "line_start":
      return { line: position.line, col: 0 };
    case "first_nonblank": {
      const match = /\S/.exec(buffer.text(position.line));
      return { line: position.line, col: match ? [...buffer.text(position.line).slice(0, match.index)].length : 0 };
    }
    case "line_end":
      return { line: position.line, col: Math.max(0, lineLength(position.line) - 1) };
    case "top":
      return { line: 0, col: 0 };
    case "bottom":
      return { line: last, col: 0 };
    case "paragraph_prev": {
      let line = position.line - 1;
      while (line > 0 && buffer.text(line).trim() !== "") line -= 1;
      return { line: clampLine(line), col: 0 };
    }
    case "paragraph_next": {
      let line = position.line + 1;
      while (line < last && buffer.text(line).trim() !== "") line += 1;
      return { line: clampLine(line), col: 0 };
    }
    case "word_next":
    case "bigword_next":
      return wordNext(position, buffer, motion === "bigword_next");
    case "word_prev":
    case "bigword_prev":
      return wordPrev(position, buffer, motion === "bigword_prev");
    case "word_end":
    case "bigword_end":
      return wordEnd(position, buffer, motion === "bigword_end");
  }
}

/** 0 = blank (including line ends), 1 = word characters, 2 = punctuation.
 * Big words treat every non-blank as one class. */
function charClass(character: string, big: boolean): number {
  if (character === "" || /\s/.test(character)) return 0;
  if (big) return 1;
  return /[\p{L}\p{N}_]/u.test(character) ? 1 : 2;
}

/** Iterates characters across lines, with a blank at each line end. */
class Walker {
  private lines = new Map<number, string[]>();

  constructor(private readonly buffer: CopyBuffer) {}

  chars(line: number): string[] {
    let cached = this.lines.get(line);
    if (!cached) {
      cached = [...this.buffer.text(line)];
      this.lines.set(line, cached);
    }
    return cached;
  }

  at(position: CopyPosition): string {
    return this.chars(position.line)[position.col] ?? "";
  }

  next(position: CopyPosition): CopyPosition | null {
    if (position.col < this.chars(position.line).length) {
      return { line: position.line, col: position.col + 1 };
    }
    if (position.line + 1 >= this.buffer.total) return null;
    return { line: position.line + 1, col: 0 };
  }

  previous(position: CopyPosition): CopyPosition | null {
    if (position.col > 0) return { line: position.line, col: position.col - 1 };
    if (position.line <= 0) return null;
    return { line: position.line - 1, col: this.chars(position.line - 1).length };
  }
}

function wordNext(start: CopyPosition, buffer: CopyBuffer, big: boolean): CopyPosition {
  const walker = new Walker(buffer);
  let position: CopyPosition | null = start;
  const startClass = charClass(walker.at(start), big);
  if (startClass !== 0) {
    while (position && charClass(walker.at(position), big) === startClass) {
      position = walker.next(position);
    }
  }
  while (position && charClass(walker.at(position), big) === 0) {
    position = walker.next(position);
  }
  return position ?? start;
}

function wordPrev(start: CopyPosition, buffer: CopyBuffer, big: boolean): CopyPosition {
  const walker = new Walker(buffer);
  let position = walker.previous(start);
  while (position && charClass(walker.at(position), big) === 0) {
    position = walker.previous(position);
  }
  if (!position) return { line: 0, col: 0 };
  const cls = charClass(walker.at(position), big);
  let previous = walker.previous(position);
  while (previous && charClass(walker.at(previous), big) === cls) {
    position = previous;
    previous = walker.previous(position);
  }
  return position;
}

function wordEnd(start: CopyPosition, buffer: CopyBuffer, big: boolean): CopyPosition {
  const walker = new Walker(buffer);
  let position = walker.next(start);
  while (position && charClass(walker.at(position), big) === 0) {
    position = walker.next(position);
  }
  if (!position) return start;
  const cls = charClass(walker.at(position), big);
  let next = walker.next(position);
  while (next && charClass(walker.at(next), big) === cls) {
    position = next;
    next = walker.next(position);
  }
  return position;
}

/** Copy mode key → motion, following Shepherd's bindings. */
export function copyMotionForKey(key: {
  name: string;
  ctrl: boolean;
  shift: boolean;
  text: string;
}): CopyMotion | null {
  if (key.ctrl) {
    switch (key.name) {
      case "b": return "page_up";
      case "f": return "page_down";
      case "u": return "half_page_up";
      case "d": return "half_page_down";
      default: return null;
    }
  }
  switch (key.text || key.name) {
    case "h": case "left": return "left";
    case "l": case "right": return "right";
    case "k": case "up": return "up";
    case "j": case "down": return "down";
    case "w": return "word_next";
    case "b": return "word_prev";
    case "e": return "word_end";
    case "W": return "bigword_next";
    case "B": return "bigword_prev";
    case "E": return "bigword_end";
    case "0": case "home": return "line_start";
    case "^": return "first_nonblank";
    case "$": case "end": return "line_end";
    case "g": return "top";
    case "G": return "bottom";
    case "{": return "paragraph_prev";
    case "}": return "paragraph_next";
    case "pageup": return "page_up";
    case "pagedown": return "page_down";
    default: return null;
  }
}
