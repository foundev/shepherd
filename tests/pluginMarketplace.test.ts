import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectMarketplaceRepository,
  loadMarketplaceCache,
  saveMarketplaceCache,
  searchPluginMarketplace,
} from "../src/server/pluginMarketplace.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("plugin marketplace", () => {
  it("searches the shepherd-plugin GitHub topic", async () => {
    let requestedUrl = "";
    const result = await searchPluginMarketplace("tools", 10, async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        total_count: 1,
        items: [{
          name: "example-tools",
          full_name: "example/example-tools",
          description: "Example tools",
          html_url: "https://github.com/example/example-tools",
          stargazers_count: 12,
          pushed_at: "2026-09-01T00:00:00Z",
          default_branch: "main",
        }],
      }), { status: 200 });
    });

    expect(requestedUrl).toContain("https://api.github.com/search/repositories");
    expect(requestedUrl).toContain("topic%3Ashepherd-plugin");
    expect(result.total).toBe(1);
    expect(result.plugins).toEqual([{
      name: "example-tools",
      repository: "example/example-tools",
      description: "Example tools",
      url: "https://github.com/example/example-tools",
      stars: 12,
      updatedAt: "2026-09-01T00:00:00Z",
      defaultBranch: "main",
    }]);
  });

  it("rejects non-success GitHub responses", async () => {
    await expect(searchPluginMarketplace("", 10, async () =>
      new Response("rate limited", { status: 403 })
    )).rejects.toThrow("status 403");
  });

  it("previews manifests from a repository tree", async () => {
    const requests: string[] = [];
    const result = await inspectMarketplaceRepository(
      "example/example-tools",
      "main",
      async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.includes("/git/trees/")) {
          return new Response(JSON.stringify({
            sha: "treesha",
            tree: [
              { path: "README.md", type: "blob", sha: "readme" },
              {
                path: "plugins/tools/shepherd-plugin.toml",
                type: "blob",
                sha: "manifestsha",
              },
            ],
          }), { status: 200 });
        }
        return new Response([
          'id = "example.tools"',
          'name = "Example Tools"',
          'version = "1.2.3"',
          "[[actions]]",
          'id = "status"',
          'title = "Status"',
          'command = ["node", "status.js"]',
          "[[build]]",
          'command = ["npm", "ci"]',
        ].join("\n"), { status: 200 });
      },
    );

    expect(result.commit).toBe("treesha");
    expect(result.manifests).toEqual([{
      id: "example.tools",
      name: "Example Tools",
      version: "1.2.3",
      manifestPath: "plugins/tools/shepherd-plugin.toml",
      manifestUrl: "https://raw.githubusercontent.com/example/example-tools/manifestsha/plugins/tools/shepherd-plugin.toml",
      actions: [{ id: "status", title: "Status" }],
      builds: 1,
    }]);
    expect(requests[0]).toContain("/git/trees/main?recursive=1");
    expect(requests[1]).toContain("raw.githubusercontent.com");
  });

  it("persists the marketplace cache atomically", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-market-"));
    temporaryDirectories.push(directory);
    const cache = {
      version: 1 as const,
      updatedAt: "2026-09-22T00:00:00Z",
      query: "",
      total: 0,
      plugins: [],
    };
    saveMarketplaceCache(directory, cache);
    expect(loadMarketplaceCache(directory)).toEqual(cache);
    expect(fs.existsSync(path.join(directory, "marketplace.json.tmp")))
      .toBe(false);
  });
});
