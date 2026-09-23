import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClientConnection } from "../src/client/connection.js";
import { ShepherdDaemon } from "../src/server/daemon.js";
import { connect } from "../src/transport.js";
import type { EventFrame, PluginCommandLogView, StateView } from "../src/types.js";

type Json = Record<string, unknown>;

/** Writes one line per invocation into the plugin state directory so the
 * test can see what each plugin process received. */
const RECORD_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const kind = process.argv[2];
let stdin = "";
const finish = () => {
  const env = process.env;
  const entry = {
    kind,
    pluginId: env.SHEPHERD_PLUGIN_ID,
    root: env.SHEPHERD_PLUGIN_ROOT,
    configDir: env.SHEPHERD_PLUGIN_CONFIG_DIR,
    stateDir: env.SHEPHERD_PLUGIN_STATE_DIR,
    socket: env.SHEPHERD_SOCKET_PATH,
    bin: env.SHEPHERD_BIN_PATH,
    workspace: env.SHEPHERD_ACTIVE_WORKSPACE_ID,
    tab: env.SHEPHERD_ACTIVE_TAB_ID,
    pane: env.SHEPHERD_ACTIVE_PANE_ID,
    action: env.SHEPHERD_PLUGIN_ACTION_ID,
    event: env.SHEPHERD_PLUGIN_EVENT,
    eventJson: env.SHEPHERD_PLUGIN_EVENT_JSON,
    entrypoint: env.SHEPHERD_PLUGIN_ENTRYPOINT_ID,
    clickedUrl: env.SHEPHERD_PLUGIN_CLICKED_URL,
    context: JSON.parse(env.SHEPHERD_PLUGIN_CONTEXT_JSON || "{}"),
    stdin,
    cwd: process.cwd(),
  };
  fs.appendFileSync(path.join(env.SHEPHERD_PLUGIN_STATE_DIR, "calls.jsonl"), JSON.stringify(entry) + "\\n");
  process.stdout.write(kind + " ok\\n");
  if (kind === "pane") setInterval(() => {}, 1000);
};
if (kind === "event") {
  process.stdin.on("data", (chunk) => { stdin += chunk; });
  process.stdin.on("end", finish);
} else {
  finish();
}
`;

describe("plugin runtime: hooks, logs, panes, link handlers", () => {
  let root: string;
  let stateRoot: string;
  let configRoot: string;
  let socketPath: string;
  let pluginRoot: string;
  let daemon: ShepherdDaemon;
  const session = "plugin-runtime";

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-plugin-rt-"));
    stateRoot = path.join(root, "state");
    configRoot = path.join(root, "config");
    socketPath = path.join(root, "daemon.sock");
    pluginRoot = path.join(root, "plugin");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "record.js"), RECORD_SCRIPT, "utf8");
    fs.writeFileSync(path.join(pluginRoot, "shepherd-plugin.toml"), [
      'id = "example.runtime"',
      'name = "Runtime"',
      'version = "0.1.0"',
      'min_shepherd_version = "0.1.0"',
      'platforms = ["linux", "macos"]',
      "",
      "[[startup]]",
      'command = ["node", "record.js", "startup"]',
      "",
      "[[actions]]",
      'id = "record"',
      'title = "Record"',
      'contexts = ["workspace", "pane"]',
      'command = ["node", "record.js", "action"]',
      "",
      "[[events]]",
      'on = ["tab.created", "pane.bell", "pane.exited"]',
      'command = ["node", "record.js", "event"]',
      "",
      "[[panes]]",
      'id = "board"',
      'title = "Board"',
      'placement = "split"',
      'command = ["node", "record.js", "pane"]',
      "",
      "[[panes]]",
      'id = "picker"',
      'title = "Picker"',
      'placement = "popup"',
      'width = "80%"',
      "height = 20",
      'command = ["node", "record.js", "pane"]',
      "",
      "[[link_handlers]]",
      'id = "issue"',
      'title = "Issue"',
      'pattern = "^https://example\\\\.com/issues/[0-9]+$"',
      'action = "record"',
    ].join("\n"), "utf8");
    process.env.SHEPHERD_STATE_HOME = stateRoot;
    process.env.SHEPHERD_CONFIG_HOME = configRoot;
    process.env.SHEPHERD_MARKETPLACE_REFRESH_MS = "0";
    daemon = new ShepherdDaemon({ session, socketPath });
    await daemon.start();
  });

  afterAll(async () => {
    await daemon.stop();
    delete process.env.SHEPHERD_CONFIG_HOME;
    delete process.env.SHEPHERD_MARKETPLACE_REFRESH_MS;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const stateDir = () =>
    path.join(stateRoot, session, "plugin-state", "example.runtime");
  const calls = (): Json[] => {
    const file = path.join(stateDir(), "calls.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Json);
  };

  it("links a plugin with the new manifest fields and exposes its config dir", async () => {
    const linked = await request({ type: "plugin.link", path: pluginRoot });
    expect(linked).toMatchObject({
      id: "example.runtime",
      minShepherdVersion: "0.1.0",
      platforms: ["linux", "macos"],
      managed: false,
      actions: [{ id: "record", contexts: ["workspace", "pane"] }],
      events: [{ on: ["tab.created", "pane.bell", "pane.exited"] }],
      panes: [
        { id: "board", placement: "split" },
        { id: "picker", placement: "popup", width: "80%", height: 20 },
      ],
      linkHandlers: [{ id: "issue", action: "record" }],
      warnings: [],
    });
    const configDir = path.join(configRoot, "plugins", "example.runtime");
    expect(fs.existsSync(configDir)).toBe(true);
    expect(await request({ type: "plugin.config-dir", pluginId: "example.runtime" }))
      .toEqual({ pluginId: "example.runtime", path: configDir });
    // Linking does not run startup hooks.
    expect(calls()).toEqual([]);
  });

  it("invokes actions with plugin env and records them in the log", async () => {
    const result = await request({
      type: "plugin.action-invoke",
      pluginId: "example.runtime",
      actionId: "record",
    }, 35_000);
    expect(result).toMatchObject({ exitCode: 0, stdout: "action ok\n" });
    const state = await request({ type: "state.get" }) as unknown as StateView;
    const call = calls().find((entry) => entry.kind === "action");
    expect(call).toMatchObject({
      pluginId: "example.runtime",
      root: pluginRoot,
      configDir: path.join(configRoot, "plugins", "example.runtime"),
      stateDir: stateDir(),
      socket: socketPath,
      action: "record",
      workspace: state.activeWorkspaceId,
      tab: state.activeTabId,
      pane: state.focusedPaneId,
      cwd: fs.realpathSync(pluginRoot),
      context: { invocation_source: "api", workspace_id: state.activeWorkspaceId },
    });
    expect(typeof call?.bin).toBe("string");

    const { logs } = await request({
      type: "plugin.log-list",
      pluginId: "example.runtime",
    }) as { logs: PluginCommandLogView[] };
    expect(logs.at(-1)).toMatchObject({
      pluginId: "example.runtime",
      kind: "action",
      actionId: "record",
      command: ["node", "record.js", "action"],
      status: "succeeded",
      exitCode: 0,
      stdout: "action ok\n",
      error: null,
    });
    expect(logs.at(-1)?.finishedAt).toBeGreaterThanOrEqual(logs.at(-1)?.startedAt ?? 0);
  });

  it("runs event hooks with the event JSON in env and on stdin", async () => {
    await request({ type: "tab.create" });
    const log = await waitForLog((entry) => entry.kind === "event" && entry.event === "tab.created");
    expect(log.status).toBe("succeeded");
    const call = calls().find((entry) => entry.kind === "event");
    expect(call?.event).toBe("tab.created");
    const payload = JSON.parse(String(call?.eventJson)) as Json;
    expect(payload).toMatchObject({ event: "tab.created", data: { type: "tab_created" } });
    expect(JSON.parse(String(call?.stdin))).toEqual(payload);
  });

  it("opens, focuses and closes a split plugin pane with plugin env", async () => {
    const before = await request({ type: "state.get" }) as unknown as StateView;
    const opened = await request({
      type: "plugin.pane-open",
      pluginId: "example.runtime",
      entrypointId: "board",
    }) as { paneId: string; placement: string; popup: boolean };
    expect(opened).toMatchObject({ placement: "split", popup: false });
    await waitFor(() => calls().some((entry) => entry.kind === "pane"));
    const call = calls().find((entry) => entry.kind === "pane");
    expect(call).toMatchObject({
      entrypoint: "board",
      pluginId: "example.runtime",
      pane: before.focusedPaneId,
    });

    const after = await request({ type: "state.get" }) as unknown as StateView;
    expect(after.focusedPaneId).toBe(opened.paneId);
    expect(after.panes.some((pane) => pane.id === opened.paneId)).toBe(true);

    await expect(request({ type: "plugin.pane-focus", paneId: before.focusedPaneId }))
      .rejects.toThrow("unknown plugin pane");
    expect(await request({ type: "plugin.pane-focus", paneId: opened.paneId }))
      .toMatchObject({ entrypointId: "board", popup: false });
    expect(await request({ type: "plugin.pane-close", paneId: opened.paneId }))
      .toEqual({ paneId: opened.paneId, closed: true });
    const closed = await request({ type: "state.get" }) as unknown as StateView;
    expect(closed.panes.some((pane) => pane.id === opened.paneId)).toBe(false);
    const log = await waitForLog((entry) => entry.kind === "pane" && entry.finishedAt !== null);
    expect(log).toMatchObject({ entrypointId: "board", command: ["node", "record.js", "pane"] });
  });

  it("delivers the exit code to hooks even after a short-lived pane is removed", async () => {
    const created = await request({ type: "pane.create", command: "exit 7", focus: false }) as unknown as StateView;
    const paneId = created.panes.at(-1)!.id;
    await waitForLog((entry) => entry.kind === "event" && entry.event === "pane.exited" && entry.status === "succeeded");
    await waitFor(() => calls().some((entry) => {
      if (entry.event !== "pane.exited") return false;
      return JSON.parse(String(entry.eventJson)).data.paneId === paneId;
    }));
    const event = calls().find((entry) => entry.event === "pane.exited" && JSON.parse(String(entry.eventJson)).data.paneId === paneId);
    expect(JSON.parse(String(event?.eventJson))).toMatchObject({
      event: "pane.exited", data: { paneId, exitCode: 7 },
    });
  });

  it("restores focus and zoom when an overlay pane closes", async () => {
    const before = await request({ type: "state.get" }) as unknown as StateView;
    const opened = await request({
      type: "plugin.pane-open",
      pluginId: "example.runtime",
      entrypointId: "board",
      placement: "overlay",
    }) as { paneId: string };
    const during = await request({ type: "state.get" }) as unknown as StateView;
    const tab = during.tabs.find((entry) => entry.id === during.activeTabId);
    expect(tab?.zoomedPaneId).toBe(opened.paneId);
    expect(during.focusedPaneId).toBe(opened.paneId);
    await request({ type: "plugin.pane-close", paneId: opened.paneId });
    const after = await request({ type: "state.get" }) as unknown as StateView;
    expect(after.focusedPaneId).toBe(before.focusedPaneId);
    expect(after.tabs.find((entry) => entry.id === after.activeTabId)?.zoomedPaneId).toBeNull();
  });

  it("opens popup entrypoints on an attached client", async () => {
    await expect(request({
      type: "plugin.pane-open",
      pluginId: "example.runtime",
      entrypointId: "picker",
    })).rejects.toThrow("no_foreground_client");

    const ui = ClientConnection.open(await connect(socketPath));
    try {
      const events: EventFrame[] = [];
      ui.setEventHandler?.((event) => events.push(event));
      await ui.request({ type: "events.subscribe" });
      const state = await ui.request({ type: "state.get" }) as StateView;
      await ui.request({
        type: "surface.subscribe",
        panes: [{ paneId: state.focusedPaneId, cols: 80, rows: 24 }],
      });
      const opened = await request({
        type: "plugin.pane-open",
        pluginId: "example.runtime",
        entrypointId: "picker",
      }) as { paneId: string; popup: boolean };
      expect(opened.popup).toBe(true);
      await waitFor(() => events.some((event) => event.event === "popup.opened"));
      expect(events.find((event) => event.event === "popup.opened")?.data).toMatchObject({
        paneId: opened.paneId,
        clientId: state.clientId,
        pluginId: "example.runtime",
        title: "Picker",
        width: "80%",
        height: "20",
      });
      await request({ type: "plugin.pane-close", paneId: opened.paneId });
      await waitFor(() => events.some((event) => event.event === "popup.closed"));
    } finally {
      ui.close();
    }
  });

  it("routes matching links to the plugin action", async () => {
    expect(await request({ type: "plugin.link-open", url: "https://example.com/other" }))
      .toEqual({ handled: false });
    const handled = await request({
      type: "plugin.link-open",
      url: "https://example.com/issues/42",
    });
    expect(handled).toMatchObject({
      handled: true,
      pluginId: "example.runtime",
      handlerId: "issue",
      actionId: "record",
    });
    await waitFor(() => calls().some((entry) => entry.clickedUrl !== undefined));
    const call = calls().find((entry) => entry.clickedUrl !== undefined);
    expect(call).toMatchObject({
      clickedUrl: "https://example.com/issues/42",
      context: {
        invocation_source: "link_click",
        clicked_url: "https://example.com/issues/42",
        link_handler_id: "issue",
      },
    });
  });

  it("runs startup hooks when a daemon starts", async () => {
    await daemon.stop();
    daemon = new ShepherdDaemon({ session, socketPath });
    await daemon.start();
    const log = await waitForLog((entry) => entry.kind === "startup");
    expect(log).toMatchObject({ event: "startup", status: "succeeded" });
    const call = calls().find((entry) => entry.kind === "startup");
    expect(call).toMatchObject({ event: "startup", context: { invocation_source: "startup" } });
  });

  it("uninstalls only managed plugins and refuses incompatible manifests", async () => {
    await expect(request({ type: "plugin.uninstall", pluginId: "example.runtime" }))
      .rejects.toThrow("locally linked");

    const managed = path.join(stateRoot, session, "managed-plugins", "example-managed");
    fs.mkdirSync(managed, { recursive: true });
    fs.writeFileSync(path.join(managed, "shepherd-plugin.toml"), [
      'id = "example.managed"',
      'name = "Managed"',
      'version = "1.0.0"',
      "[[actions]]",
      'id = "noop"',
      'command = ["node", "-e", "0"]',
    ].join("\n"), "utf8");
    expect(await request({ type: "plugin.link", path: managed })).toMatchObject({ managed: true });
    expect(await request({ type: "plugin.uninstall", pluginId: "example.managed" }))
      .toEqual({ pluginId: "example.managed", removed: true, path: managed });
    expect(fs.existsSync(managed)).toBe(false);

    const future = path.join(root, "future");
    fs.mkdirSync(future);
    fs.writeFileSync(path.join(future, "shepherd-plugin.toml"), [
      'id = "example.future"',
      'name = "Future"',
      'version = "1.0.0"',
      'min_shepherd_version = "999.0.0"',
      "[[actions]]",
      'id = "noop"',
      'command = ["node", "-e", "0"]',
    ].join("\n"), "utf8");
    await expect(request({ type: "plugin.link", path: future }))
      .rejects.toThrow("requires Shepherd 999.0.0 or newer");
  });

  async function waitForLog(
    predicate: (entry: PluginCommandLogView) => boolean,
  ): Promise<PluginCommandLogView> {
    let found: PluginCommandLogView | undefined;
    await waitFor(async () => {
      const { logs } = await request({
        type: "plugin.log-list",
        pluginId: "example.runtime",
      }) as { logs: PluginCommandLogView[] };
      found = logs.find((entry) => predicate(entry) && entry.status !== "running");
      return found !== undefined;
    });
    return found as PluginCommandLogView;
  }

  async function request(
    payload: Json,
    timeoutMs = 5_000,
  ): Promise<Json> {
    const socket = await connect(socketPath);
    const connection = ClientConnection.open(socket);
    try {
      return await connection.request(payload as never, timeoutMs) as Json;
    } finally {
      connection.close();
    }
  }


}, 60_000);

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not met in time");
}
