import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  managedPluginPath,
  parseGithubPluginSource,
} from "../src/server/pluginInstall.js";

describe("plugin installation", () => {
  it("accepts only safe GitHub shorthand", () => {
    expect(parseGithubPluginSource("example/tools")).toEqual({
      owner: "example",
      repo: "tools",
      subdir: null,
    });
    expect(parseGithubPluginSource("example/monorepo/plugin")).toEqual({
      owner: "example",
      repo: "monorepo",
      subdir: "plugin",
    });
    expect(() => parseGithubPluginSource("https://github.com/example/tools"))
      .toThrow("accepts only");
    expect(() => parseGithubPluginSource("../escape")).toThrow(
      "invalid GitHub owner",
    );
  });

  it("places managed plugins under a session-safe directory", () => {
    const source = parseGithubPluginSource("example/monorepo/tools/native");
    expect(managedPluginPath("/tmp/shepherd", source)).toBe(path.join(
      "/tmp/shepherd",
      "managed-plugins",
      "example-monorepo-tools-native",
    ));
  });
});
