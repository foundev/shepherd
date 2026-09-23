import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClientConnection } from "../src/client/connection.js";
import { loadMarketplaceCache } from "../src/server/pluginMarketplace.js";
import { ShepherdDaemon } from "../src/server/daemon.js";
import { connect } from "../src/transport.js";

describe("background marketplace refresh", () => {
  let stateRoot: string;
  let socketPath: string;
  let daemon: ShepherdDaemon;
  const originalFetch = globalThis.fetch;
  const originalInterval = process.env.SHEPHERD_MARKETPLACE_REFRESH_MS;

  beforeAll(() => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-market-refresh-"));
    socketPath = path.join(stateRoot, "daemon.sock");
    process.env.SHEPHERD_STATE_HOME = stateRoot;
    process.env.SHEPHERD_MARKETPLACE_REFRESH_MS = "20";
    Object.assign(globalThis, {
      fetch: async () => new Response(JSON.stringify({
        total_count: 1,
        items: [{
          name: "example-tools",
          full_name: "example/example-tools",
          description: "Example tools",
          html_url: "https://github.com/example/example-tools",
          stargazers_count: 7,
          pushed_at: "2026-09-01T00:00:00Z",
          default_branch: "main",
        }],
      }), { status: 200 }),
    });
  });

  afterAll(async () => {
    Object.assign(globalThis, { fetch: originalFetch });
    if (originalInterval === undefined) {
      delete process.env.SHEPHERD_MARKETPLACE_REFRESH_MS;
    } else {
      process.env.SHEPHERD_MARKETPLACE_REFRESH_MS = originalInterval;
    }
    await daemon.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("refreshes the marketplace automatically and on demand", async () => {
    daemon = new ShepherdDaemon({ session: "market", socketPath });
    await daemon.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const backgroundCache = loadMarketplaceCache(path.join(stateRoot, "market"));
    expect(backgroundCache?.plugins.map((plugin) => plugin.repository))
      .toEqual(["example/example-tools"]);

    const socket = await connect(socketPath);
    const connection = ClientConnection.open(socket);
    try {
      const refreshed = await connection.request({
        type: "marketplace.refresh",
      }, 5_000) as {
        total: number;
        plugins: Array<{ repository: string }>;
      };
      expect(refreshed.total).toBe(1);
      expect(refreshed.plugins[0]?.repository).toBe("example/example-tools");
    } finally {
      connection.close();
    }
  });
}, 10_000);
