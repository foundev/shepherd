import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { SurfaceSubscription } from "../src/server/surfaces.js";
import {
  applySurfaceFrame,
  lineText,
  selectionText,
  wordAt,
  type TextSelection,
} from "../src/client/surfaces.js";
import { highlight } from "../src/client/TerminalPane.js";
import {
  labelRegions,
  paneContentRect,
  regionAt,
  splitAt,
  computeLayout,
} from "../src/client/geometry.js";
import { ScreenWriter } from "../src/client/screenWriter.js";
import type { PaneTerminal } from "../src/server/terminal.js";
import type { TerminalLine } from "../src/types.js";

function fakePane(lines: string[], revision: number): PaneTerminal {
  return {
    id: "p1",
    revision,
    rows: lines.length,
    cols: 20,
    baseLine: 0,
    terminalTitle: "",
    modes: {
      applicationCursorKeys: false,
      bracketedPaste: false,
      mouseTracking: "none",
      sendFocus: false,
      alternateScreen: false,
    },
    view: () => ({
      lines: lines.map((text) => text ? [{ text }] : []),
      cursor: { x: 0, y: 0, visible: true, shape: "block", blink: false },
      scroll: { offsetFromBottom: 0, maxOffsetFromBottom: 0 },
    }),
  } as unknown as PaneTerminal;
}

describe("surface subscriptions", () => {
  it("sends a full frame first, then only changed rows", () => {
    const subscription = new SurfaceSubscription("p1", 20, 3);
    const first = subscription.frame(fakePane(["a", "b", "c"], 1));
    expect(first?.full).toBe(true);
    expect(Object.keys(first?.lines ?? {})).toEqual(["0", "1", "2"]);

    expect(subscription.frame(fakePane(["a", "b", "c"], 1))).toBeNull();
    expect(subscription.frame(fakePane(["a", "b", "c"], 2))).toBeNull();

    const second = subscription.frame(fakePane(["a", "B", "c"], 3));
    expect(second?.full).toBe(false);
    expect(second?.lines).toEqual({ 1: [{ text: "B" }] });

    subscription.reset(20, 3);
    expect(subscription.frame(fakePane(["a", "B", "c"], 3))?.full).toBe(true);
  });

  it("keeps unchanged row identity when applying a frame", () => {
    const subscription = new SurfaceSubscription("p1", 20, 2);
    const surface = applySurfaceFrame(
      undefined,
      subscription.frame(fakePane(["same", "old"], 1))!,
    );
    const next = applySurfaceFrame(
      surface,
      subscription.frame(fakePane(["same", "new"], 2))!,
    );
    expect(next.lines[0]).toBe(surface.lines[0]);
    expect(next.lines[1]).toEqual([{ text: "new" }]);
  });
});

describe("selection", () => {
  const lines: TerminalLine[] = [
    [{ text: "hello world" }],
    [{ text: "second line   " }],
  ];

  it("extracts character ranges across rows", () => {
    const selection: TextSelection = {
      paneId: "p1",
      anchor: { col: 6, row: 0 },
      head: { col: 5, row: 1 },
      mode: "char",
    };
    expect(selectionText(selection, (row) => lineText(lines[row] ?? [])))
      .toBe("world\nsecond");
  });

  it("extracts whole lines and trims trailing blanks", () => {
    expect(selectionText({
      paneId: "p1",
      anchor: { col: 3, row: 1 },
      head: { col: 0, row: 1 },
      mode: "line",
    }, (row) => lineText(lines[row] ?? []))).toBe("second line");
  });

  it("finds the word under a cell", () => {
    expect(wordAt(lines[0] ?? [], 8)).toEqual([6, 10]);
    expect(wordAt(lines[0] ?? [], 1)).toEqual([0, 4]);
  });

  it("inverts only the selected cells", () => {
    expect(highlight([{ text: "abcdef", color: "red" }], [2, 4], 10)).toEqual([
      { text: "ab", color: "red", inverse: undefined },
      { text: "cd", color: "red", inverse: true },
      { text: "ef", color: "red", inverse: undefined },
    ]);
    expect(highlight([{ text: "ab" }], [1, 5], 10)).toEqual([
      { text: "a", inverse: undefined },
      { text: "b", inverse: true },
      { text: "   ", inverse: true },
    ]);
  });
});

describe("geometry", () => {
  const main = { x: 0, y: 3, width: 80, height: 20 };
  const layout = computeLayout({
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
  }, main);

  it("tiles the main area without gaps or overlap", () => {
    const area = layout.panes.reduce(
      (total, pane) => total + pane.rect.width * pane.rect.height,
      0,
    );
    expect(area).toBe(80 * 20);
    expect(layout.panes.map((pane) => pane.rect)).toEqual([
      { x: 0, y: 3, width: 40, height: 20 },
      { x: 40, y: 3, width: 40, height: 10 },
      { x: 40, y: 13, width: 40, height: 10 },
    ]);
  });

  it("finds split borders on either side of the seam", () => {
    expect(splitAt(layout.splits, 39, 5)?.paneId).toBe("p1");
    expect(splitAt(layout.splits, 40, 5)?.paneId).toBe("p1");
    expect(splitAt(layout.splits, 50, 12)?.paneId).toBe("p2");
    expect(splitAt(layout.splits, 50, 13)?.paneId).toBe("p2");
    expect(splitAt(layout.splits, 20, 5)).toBeNull();
  });

  it("sizes pane content inside the border and scrollbar gutter", () => {
    const rect = { x: 40, y: 3, width: 40, height: 10 };
    expect(paneContentRect(rect, { bordered: true, scrollbar: false }))
      .toEqual({ x: 41, y: 4, width: 38, height: 8 });
    expect(paneContentRect(rect, { bordered: true, scrollbar: true }))
      .toEqual({ x: 41, y: 4, width: 37, height: 8 });
    expect(paneContentRect(rect, { bordered: false, scrollbar: true }))
      .toEqual({ x: 40, y: 3, width: 39, height: 10 });
  });

  it("maps clicks to labels by display width", () => {
    const regions = labelRegions([
      { id: "t1", label: "1 main" },
      { id: "t2", label: "2 日本" },
    ]);
    expect(regionAt(regions, 1)).toBe("t1");
    expect(regionAt(regions, 6)).toBe("t1");
    expect(regionAt(regions, 7)).toBeNull();
    expect(regionAt(regions, 8)).toBe("t2");
    expect(regionAt(regions, 13)).toBe("t2");
  });
});

describe("screen writer", () => {
  function output(): NodeJS.WriteStream & { written: string[] } {
    const stream = new EventEmitter() as NodeJS.WriteStream & {
      written: string[];
    };
    stream.written = [];
    Object.assign(stream, {
      columns: 10,
      rows: 3,
      write: (data: string) => {
        stream.written.push(data);
        return true;
      },
    });
    return stream;
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  it("rewrites only changed rows and places the cursor", async () => {
    const stream = output();
    const writer = new ScreenWriter(stream, 1000);
    writer.write("aaa\nbbb\nccc");
    await settle();
    expect(stream.written.at(-1)).toContain("\x1b[1;1Haaa");
    expect(stream.written.at(-1)).toContain("\x1b[3;1Hccc");

    writer.write("aaa\nBBB\nccc");
    writer.setCursor({ x: 4, y: 2, shape: "bar", blink: false });
    await settle();
    const update = stream.written.at(-1) ?? "";
    expect(update).toContain("\x1b[2;1HBBB");
    expect(update).not.toContain("aaa");
    expect(update).toContain("\x1b[6 q");
    expect(update).toContain("\x1b[3;5H\x1b[?25h");

    const count = stream.written.length;
    writer.write("aaa\nBBB\nccc");
    await settle();
    expect(stream.written).toHaveLength(count);
    writer.dispose();
  });
});
