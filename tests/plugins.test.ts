import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPluginCompatible,
  compareVersions,
  loadPluginManifest,
  loadPluginRegistry,
  matchLinkHandler,
  pluginConfigDirectory,
  pluginEnvironment,
  PluginLogStore,
  savePluginRegistry,
  shellCommandLine,
  supportsPlatform,
} from "../src/server/plugins.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("plugins", () => {
  it("loads directory manifests and validates actions", () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, "shepherd-plugin.toml"), [
      'id = "example.greet"',
      'name = "Greet"',
      'version = "0.1.0"',
      "",
      "[[build]]",
      'command = ["node", "-e", "0"]',
      "",
      "[[actions]]",
      'id = "hello"',
      'title = "Say hello"',
      'command = ["node", "-e", "console.log(\'hello\')"]',
      "",
    ].join("\n"), "utf8");

    const manifest = loadPluginManifest(root);
    expect(manifest.id).toBe("example.greet");
    expect(manifest.root).toBe(root);
    expect(manifest.actions).toEqual([{
      id: "hello",
      title: "Say hello",
      command: ["node", "-e", "console.log('hello')"],
    }]);
    expect(manifest.builds).toEqual([{
      command: ["node", "-e", "0"],
    }]);
  });

  it("rejects duplicate action IDs", () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, "shepherd-plugin.toml"), [
      'id = "example.bad"',
      'name = "Bad"',
      'version = "0.1.0"',
      "[[actions]]",
      'id = "same"',
      'command = ["true"]',
      "[[actions]]",
      'id = "same"',
      'command = ["true"]',
    ].join("\n"), "utf8");

    expect(() => loadPluginManifest(root)).toThrow(
      "plugin action IDs must be unique",
    );
  });

  it("persists the local plugin registry atomically", () => {
    const root = temporaryDirectory();
    savePluginRegistry(root, [{
      manifestPath: "/tmp/example/shepherd-plugin.toml",
      enabled: true,
    }]);
    expect(loadPluginRegistry(root)).toEqual([{
      manifestPath: "/tmp/example/shepherd-plugin.toml",
      enabled: true,
    }]);
    expect(fs.existsSync(path.join(root, "plugins.json.tmp"))).toBe(false);
  });
});

describe("plugin manifest v2 fields", () => {
  const manifestFor = (lines: string[]) => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, "shepherd-plugin.toml"), [
      'id = "example.full"',
      'name = "Full"',
      'version = "1.2.3"',
      ...lines,
    ].join("\n"), "utf8");
    return () => loadPluginManifest(root);
  };

  it("parses startup, events, panes, link handlers, contexts and platforms", () => {
    const manifest = manifestFor([
      'description = "Everything"',
      'min_shepherd_version = "0.1.0"',
      'platforms = ["linux", "macos"]',
      "[[startup]]",
      'command = ["node", "start.js"]',
      "[[actions]]",
      'id = "open"',
      'title = "Open"',
      'contexts = ["pane", "selection"]',
      'platforms = ["macos"]',
      'command = ["node", "open.js"]',
      "[[events]]",
      'on = "workspace.created"',
      'command = ["node", "a.js"]',
      "[[events]]",
      'on = ["pane.created", "no.such.event"]',
      'command = ["node", "b.js"]',
      "[[panes]]",
      'id = "board"',
      'command = ["node", "board.js"]',
      "[[panes]]",
      'id = "picker"',
      'placement = "popup"',
      'width = "80%"',
      "height = 20",
      'command = ["node", "picker.js"]',
      "[[link_handlers]]",
      'id = "docs"',
      'pattern = "^https://docs\\\\.example\\\\.com/"',
      'action = "open"',
    ])();
    expect(manifest).toMatchObject({
      description: "Everything",
      minShepherdVersion: "0.1.0",
      platforms: ["linux", "macos"],
      startup: [{ command: ["node", "start.js"] }],
      actions: [{ id: "open", contexts: ["pane", "selection"], platforms: ["macos"] }],
      events: [
        { on: ["workspace.created"], command: ["node", "a.js"] },
        { on: ["pane.created", "no.such.event"], command: ["node", "b.js"] },
      ],
      panes: [
        { id: "board", title: "board", placement: "overlay" },
        { id: "picker", placement: "popup", width: "80%", height: 20 },
      ],
      linkHandlers: [{ id: "docs", title: "docs", action: "open" }],
    });
    expect(manifest.warnings).toEqual(["events[1] listens to unknown event no.such.event"]);
  });

  it("rejects invalid placements, sizes, contexts, platforms and handlers", () => {
    const action = ["[[actions]]", 'id = "go"', 'command = ["true"]'];
    expect(manifestFor([...action, "[[panes]]", 'id = "p"', 'placement = "floating"', 'command = ["x"]']))
      .toThrow("placement must be one of");
    expect(manifestFor([...action, "[[panes]]", 'id = "p"', 'width = "wide"', 'command = ["x"]']))
      .toThrow("width must be");
    expect(manifestFor(['platforms = ["beos"]', ...action])).toThrow("platforms must be one of");
    expect(manifestFor(["[[actions]]", 'id = "go"', 'contexts = ["everywhere"]', 'command = ["true"]']))
      .toThrow("contexts must be one of");
    expect(manifestFor([...action, "[[link_handlers]]", 'id = "l"', 'pattern = "x"', 'action = "missing"']))
      .toThrow("names unknown action missing");
    expect(manifestFor([...action, "[[link_handlers]]", 'id = "l"', 'pattern = "("', 'action = "go"']))
      .toThrow("not a valid regular expression");
    expect(manifestFor([...action, "[[events]]", "on = []", 'command = ["x"]']))
      .toThrow("must name at least one event");
    expect(manifestFor(['min_shepherd_version = "soon"', ...action])).toThrow("invalid min_shepherd_version");
    expect(manifestFor([])).toThrow("declares no actions");
  });

  it("checks the minimum Shepherd version and platforms", () => {
    const manifest = manifestFor([
      'min_shepherd_version = "0.2.0"',
      'platforms = ["linux"]',
      "[[actions]]",
      'id = "go"',
      'command = ["true"]',
    ])();
    expect(() => assertPluginCompatible(manifest, "0.1.9", "linux")).toThrow("requires Shepherd 0.2.0");
    expect(() => assertPluginCompatible(manifest, "0.2.0", "macos")).toThrow("does not support macos");
    expect(() => assertPluginCompatible(manifest, "0.10.0", "linux")).not.toThrow();
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("v1.0", "1.0.0")).toBe(0);
    expect(supportsPlatform(undefined, ["linux"], "macos")).toBe(false);
    expect(supportsPlatform(["macos"], ["linux"], "macos")).toBe(true);
    expect(supportsPlatform(undefined, undefined, "windows")).toBe(true);
  });

  it("matches link handlers in plugin and manifest order, skipping disabled plugins", () => {
    const load = (id: string, pattern: string) => manifestFor([
      "[[actions]]",
      'id = "go"',
      'command = ["true"]',
      "[[link_handlers]]",
      `id = "${id}"`,
      `pattern = "${pattern}"`,
      'action = "go"',
    ])();
    const first = load("first", "^https://a\\\\.test/");
    const second = load("second", "^https://");
    const url = "https://a.test/x";
    expect(matchLinkHandler([
      { manifest: first, enabled: true },
      { manifest: second, enabled: true },
    ], url)?.handler.id).toBe("first");
    expect(matchLinkHandler([
      { manifest: first, enabled: false },
      { manifest: second, enabled: true },
    ], url)?.handler.id).toBe("second");
    expect(matchLinkHandler([{ manifest: first, enabled: true }], "http://b.test")).toBeNull();
  });

  it("builds the plugin environment and config directory", () => {
    const manifest = manifestFor(["[[actions]]", 'id = "go"', 'command = ["true"]'])();
    const env = pluginEnvironment(manifest, {
      socketPath: "/tmp/s.sock",
      binPath: "/bin/shepherd",
      configDirectory: "/cfg",
      stateDirectory: "/state",
    }, {
      invocation_source: "api",
      workspace_id: "w1",
      tab_id: "t1",
      focused_pane_id: "p1",
    }, { SHEPHERD_PLUGIN_ACTION_ID: "go" });
    expect(env).toMatchObject({
      SHEPHERD_PLUGIN_ID: "example.full",
      SHEPHERD_PLUGIN_ROOT: manifest.root,
      SHEPHERD_PLUGIN_CONFIG_DIR: "/cfg",
      SHEPHERD_PLUGIN_STATE_DIR: "/state",
      SHEPHERD_SOCKET_PATH: "/tmp/s.sock",
      SHEPHERD_BIN_PATH: "/bin/shepherd",
      SHEPHERD_ACTIVE_WORKSPACE_ID: "w1",
      SHEPHERD_ACTIVE_TAB_ID: "t1",
      SHEPHERD_ACTIVE_PANE_ID: "p1",
      SHEPHERD_PLUGIN_ACTION_ID: "go",
    });
    expect(JSON.parse(env.SHEPHERD_PLUGIN_CONTEXT_JSON ?? "")).toMatchObject({ workspace_id: "w1" });
    expect("SHEPHERD_PLUGIN_CLICKED_URL" in env).toBe(false);
    expect(pluginConfigDirectory("example.full", { SHEPHERD_CONFIG_HOME: "/home/x/cfg" }))
      .toBe(path.join("/home/x/cfg", "plugins", "example.full"));
    expect(pluginConfigDirectory("a.b", { XDG_CONFIG_HOME: "/xdg" }))
      .toBe(path.join("/xdg", "shepherd", "plugins", "a.b"));
    expect(() => pluginConfigDirectory("../escape")).toThrow("invalid plugin id");
    expect(shellCommandLine(["node", "my script.js", "it's"]))
      .toBe("node 'my script.js' 'it'\\''s'");
  });

  it("keeps a bounded log per plugin with output tails", () => {
    const store = new PluginLogStore(2);
    const result = {
      exitCode: 0,
      stdout: "x".repeat(20_000),
      stderr: "",
      timedOut: false,
      error: null,
    };
    for (let index = 0; index < 3; index += 1) {
      const log = store.start({ pluginId: "a", kind: "action", actionId: `a${index}`, command: ["true"] });
      store.finish(log, result);
    }
    const failed = store.start({ pluginId: "b", kind: "event", event: "tab.created", command: ["false"] });
    store.finish(failed, { ...result, exitCode: 1, stdout: "" });
    expect(store.list("a").map((entry) => entry.actionId)).toEqual(["a1", "a2"]);
    expect(store.list("a")[0]?.stdout.length).toBe(8_000);
    expect(store.list("b")[0]).toMatchObject({ status: "failed", exitCode: 1, event: "tab.created" });
    expect(store.list(undefined, 2).map((entry) => entry.pluginId)).toEqual(["a", "b"]);
    expect(store.list().length).toBe(3);
  });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-plugin-"));
  directories.push(directory);
  return directory;
}
