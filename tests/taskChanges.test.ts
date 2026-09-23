import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { parseTaskChanges, taskChanges } from "../src/server/taskChanges.js";

describe("checkout changes", () => {
  it("preserves spaces and rename sources and bounds very large checkouts", () => {
    expect(parseTaskChanges("R  new name.ts\0old name.ts\0 M modified.ts\0?? new file.txt\0")).toEqual({ total: 3, files: [
      { status: "R ", path: "new name.ts", from: "old name.ts" }, { status: " M", path: "modified.ts" }, { status: "??", path: "new file.txt" },
    ] });
    const large = parseTaskChanges(Array.from({ length: 300 }, (_, i) => `?? file${i}\0`).join(""));
    expect(large.total).toBe(300); expect(large.files).toHaveLength(200);
  });
  it("reads uncommitted files from a real repository without changing the index", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-changes-"));
    try {
      expect(await taskChanges(root)).toBeNull();
      execFileSync("git", ["init", "--quiet", root]);
      fs.writeFileSync(path.join(root, "new file.txt"), "new");
      expect(await taskChanges(root)).toEqual({ total: 1, files: [{ path: "new file.txt", status: "??" }] });
      expect(fs.existsSync(path.join(root, ".git", "index"))).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
