import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { apiSchema } from "../src/apiSchema.js";

describe("API schema", () => {
  it("contains every request method declared in the protocol", () => {
    const source = fs.readFileSync(
      path.resolve("src/types.ts"),
      "utf8",
    );
    const requestType = source.slice(
      source.indexOf("export type ShepherdRequest"),
      source.indexOf("export type ShepherdResponse"),
    );
    const declared = new Set(
      [...requestType.matchAll(/type:\s*"([^"]+)"/g)]
        .map((match) => match[1])
        .filter((value) => value !== "split" && value !== "pane"),
    );
    const documented = new Set(apiSchema.methods.map((method) => method.name));
    expect([...documented].sort()).toEqual([...declared].sort());
  });

  it("uses unique method names and stable schema versions", () => {
    expect(new Set(apiSchema.methods.map((method) => method.name)).size)
      .toBe(apiSchema.methods.length);
    expect(apiSchema.protocolVersion).toBe(1);
    expect(apiSchema.schemaVersion).toBe(2);
  });
});
