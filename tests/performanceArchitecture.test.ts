import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("render-scale benchmark", () => {
  it("covers low and pane-scaled cardinalities", () => {
    const source = fs.readFileSync(
      path.resolve("scripts/bench-render-scale.tsx"),
      "utf8",
    );
    expect(source).toContain("[1, 15, 50]");
    expect(source).toContain("instance.unmount()");
    expect(source).toContain("layoutGeometry");
    expect(source).toContain("unwrapTerminalLines");
    expect(source).toContain("TerminalPane");
  });
});
