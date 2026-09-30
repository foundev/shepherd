import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  bin?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
};

// npm `files` is an allowlist: a path ships when it or a parent dir is listed.
// (Without `files`, npm falls back to .gitignore — which excludes dist/.)
function shipped(relPath: string, files: string[]): boolean {
  const parts = relPath.split("/");
  return parts.some((_, index) => files.includes(parts.slice(0, index + 1).join("/")));
}

describe("packaging", () => {
  it("ships every bin entry point", () => {
    const files = pkg.files ?? [];
    const targets = Object.values(pkg.bin ?? {});
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(shipped(target.replace(/^\.\//, ""), files)).toBe(true);
    }
  });

  it("rebuilds dist before every publish", () => {
    expect(pkg.scripts?.prepublishOnly ?? "").toContain("build");
  });
});
