import { describe, expect, it } from "vitest";
import {
  layoutGeometry,
  paneIds,
  removePane,
  resizePaneRatio,
  splitPane,
  swapPaneIds,
} from "../src/server/layout.js";

describe("layout", () => {
  it("splits a pane and preserves both IDs", () => {
    const layout = splitPane(
      { kind: "pane", paneId: "p1" },
      "p1",
      "p2",
      "right",
    );
    expect(paneIds(layout)).toEqual(["p1", "p2"]);
  });

  it("removes a pane and collapses its split", () => {
    const split = splitPane(
      { kind: "pane", paneId: "p1" },
      "p1",
      "p2",
      "down",
    );
    expect(removePane(split, "p2")).toEqual({
      kind: "pane",
      paneId: "p1",
    });
  });

  it("allocates non-overlapping horizontal geometry", () => {
    const layout = splitPane(
      { kind: "pane", paneId: "p1" },
      "p1",
      "p2",
      "right",
      0.5,
    );
    const geometry = layoutGeometry(layout, {
      x: 0,
      y: 0,
      width: 100,
      height: 30,
    });
    expect(geometry[0]?.rect).toEqual({
      x: 0,
      y: 0,
      width: 50,
      height: 30,
    });
    expect(geometry[1]?.rect).toEqual({
      x: 50,
      y: 0,
      width: 50,
      height: 30,
    });
  });

  it("swaps two pane IDs anywhere in a tree", () => {
    const layout = splitPane(
      splitPane(
        { kind: "pane", paneId: "p1" },
        "p1",
        "p2",
        "down",
      ),
      "p2",
      "p3",
      "right",
    );
    expect(paneIds(swapPaneIds(layout, "p1", "p3"))).toEqual([
      "p3",
      "p2",
      "p1",
    ]);
  });

  it("resizes the split containing a target pane", () => {
    const layout = splitPane(
      { kind: "pane", paneId: "p1" },
      "p1",
      "p2",
      "right",
      0.5,
    );
    expect(resizePaneRatio(layout, "p1", 0.1).ratio).toBeCloseTo(0.6);
    expect(resizePaneRatio(layout, "p2", 0.1).ratio).toBeCloseTo(0.4);
  });
});
