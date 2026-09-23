import { describe, expect, it } from "vitest";
import { copyMotionForKey, moveCopyCursor, type CopyBuffer } from "../src/client/copyMode.js";
import { decodeKey } from "../src/client/input.js";

const lines = [
  "  foo.bar(baz) qux",
  "",
  "second-line words",
  "third",
];
const buffer: CopyBuffer = {
  text: (line) => lines[line] ?? "",
  total: lines.length,
  page: 3,
};

function move(line: number, col: number, motion: Parameters<typeof moveCopyCursor>[1]) {
  return moveCopyCursor({ line, col }, motion, buffer);
}

describe("copy mode motions", () => {
  it("moves by word, WORD and word end", () => {
    expect(move(0, 2, "word_next")).toEqual({ line: 0, col: 5 });
    expect(move(0, 5, "word_next")).toEqual({ line: 0, col: 6 });
    expect(move(0, 2, "bigword_next")).toEqual({ line: 0, col: 15 });
    expect(move(0, 15, "word_next")).toEqual({ line: 2, col: 0 });
    expect(move(0, 2, "word_end")).toEqual({ line: 0, col: 4 });
    expect(move(0, 2, "bigword_end")).toEqual({ line: 0, col: 13 });
    expect(move(2, 0, "word_prev")).toEqual({ line: 0, col: 15 });
    expect(move(0, 10, "word_prev")).toEqual({ line: 0, col: 9 });
    expect(move(0, 10, "bigword_prev")).toEqual({ line: 0, col: 2 });
  });

  it("moves within and between lines", () => {
    expect(move(0, 8, "line_start")).toEqual({ line: 0, col: 0 });
    expect(move(0, 8, "first_nonblank")).toEqual({ line: 0, col: 2 });
    expect(move(0, 0, "line_end")).toEqual({ line: 0, col: 17 });
    expect(move(0, 17, "down")).toEqual({ line: 1, col: 0 });
    expect(move(2, 12, "down")).toEqual({ line: 3, col: 4 });
    expect(move(3, 0, "down")).toEqual({ line: 3, col: 0 });
    expect(move(2, 3, "top")).toEqual({ line: 0, col: 0 });
    expect(move(0, 3, "bottom")).toEqual({ line: 3, col: 0 });
    expect(move(3, 0, "paragraph_prev")).toEqual({ line: 1, col: 0 });
    expect(move(0, 0, "paragraph_next")).toEqual({ line: 1, col: 0 });
  });

  it("maps Shepherd's copy mode keys", () => {
    expect(copyMotionForKey(decodeKey("w"))).toBe("word_next");
    expect(copyMotionForKey(decodeKey("W"))).toBe("bigword_next");
    expect(copyMotionForKey(decodeKey("$"))).toBe("line_end");
    expect(copyMotionForKey(decodeKey("G"))).toBe("bottom");
    expect(copyMotionForKey(decodeKey("\x15"))).toBe("half_page_up");
    expect(copyMotionForKey(decodeKey("\x06"))).toBe("page_down");
    expect(copyMotionForKey(decodeKey("\x1b[A"))).toBe("up");
    expect(copyMotionForKey(decodeKey("x"))).toBeNull();
  });
});
