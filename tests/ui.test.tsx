import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { App } from "../src/client/App.js";
import { configureTerminalColors } from "../src/client/colors.js";
import { applyTheme } from "../src/client/theme.js";
import { defaultLoadedConfig } from "../src/config/model.js";
import * as notifications from "../src/client/notifications.js";
import type { ShepherdRequest, StateView } from "../src/types.js";

describe("Shepherd UI", () => {
  it.each([
    ["2", false], ["2", true], ["3", false], ["3", true],
  ] as const)("refreshes idle pane and chrome colors on appearance changes (level=%s, mobile=%s)", async (level, mobile) => {
    const restore = configureTerminalColors({ isTTY: true }, { FORCE_COLOR: level });
    const darkBg = level === "2" ? "\x1b[48;5;234m" : "\x1b[48;2;16;23;34m";
    const darkSidebar = level === "2" ? "\x1b[48;5;233m" : "\x1b[48;2;11;17;27m";
    const darkFg = level === "2" ? "\x1b[38;5;255m" : "\x1b[38;2;233;240;242m";
    const lightBg = level === "2" ? "\x1b[48;5;231m" : "\x1b[48;2;248;250;248m";
    const lightFg = level === "2" ? "\x1b[38;5;235m" : "\x1b[38;2;25;48;46m";
    const config = defaultLoadedConfig();
    config.config.theme.auto_switch = true;
    config.config.ui.mobile_width_threshold = mobile ? 100 : 0;
    const instance = render(<App connection={new FakeConnection(testState())} config={config} />);
    try {
      await flushApp();
      expect(instance.lastFrame()).toContain(darkBg);
      instance.stdin.write("\x1b[?997;2n");
      await flushApp();
      const light = instance.lastFrame() ?? "";
      expect(light).toContain(lightBg);
      expect(light).not.toContain(darkBg);
      expect(light).not.toContain(darkSidebar);
      // In 256 colors the light theme's dividers share an index with the
      // dark theme's text. Check a text label rather than banning the index.
      expect(light).toContain(`${lightFg}production`);
      expect(light).not.toContain(`${darkFg}production`);

      if (mobile) {
        instance.stdin.write("\x02w");
        await flushApp();
        expect(instance.lastFrame()).toContain("+ new workspace");
      }
      instance.stdin.write("\x1b[?997;1n");
      await flushApp();
      const dark = instance.lastFrame() ?? "";
      expect(dark).toContain(darkBg);
      expect(dark).not.toContain(lightBg);
      expect(dark).not.toContain(`${lightFg}production`);
    } finally {
      instance.unmount();
      restore();
      applyTheme("shepherd");
    }
  });

  it("pages and scrolls overflow agents without sending wheel input to a pane", async () => {
    const state = { ...testState(), machines: [] };
    const workspace = state.workspaces[0]!;
    for (let i = 3; i < 18; i += 1) {
      state.panes.push({ ...state.panes[1]!, id: `p${i}`, displayAgent: `agent-${i}` });
      workspace.tabs.push({ id: `t${i}`, name: `Agent ${i}`, layout: { kind: "pane", paneId: `p${i}` } });
    }
    const connection = new FakeConnection(state);
    const instance = render(<App connection={connection} />);
    try {
      await flushApp();
      const lines = (instance.lastFrame() ?? "").split("\n");
      const row = lines.findIndex((line) => line.includes("next ↓"));
      const column = lines[row]!.indexOf("next ↓") + 1;
      expect(row).toBeGreaterThan(0);
      instance.stdin.write(`\x1b[<0;${column};${row + 1}M`);
      instance.stdin.write(`\x1b[<0;${column};${row + 1}m`);
      await flushApp();
      const paged = instance.lastFrame();
      expect(paged).toContain("↑ prev");
      expect(paged).not.toBe(lines.join("\n"));
      instance.stdin.write(`\x1b[<65;4;${row}M`);
      await flushApp();
      expect(instance.lastFrame()).not.toBe(paged);
      expect(connection.requests.some((request) => request.type === "surface.scroll" || request.type === "pane.mouse")).toBe(false);
    } finally { instance.unmount(); }
  });

  it("toggles the sidebar agent grouping with its shortcut", async () => {
    const connection = new FakeConnection({ ...testState(), machines: [] });
    const instance = render(<App connection={connection} />);
    try {
      await flushApp();
      expect(instance.lastFrame()).toMatch(/ AGENTS 1 +status/);
      expect(instance.lastFrame()).toContain("× NEEDS YOU");
      instance.stdin.write("\x02d"); await flushApp();
      const grouped = instance.lastFrame() ?? "";
      expect(grouped).toMatch(/ AGENTS 1 +spaces/);
      expect(grouped).not.toContain("× NEEDS YOU");
      instance.stdin.write("\x02d"); await flushApp();
      expect(instance.lastFrame()).toContain("× NEEDS YOU");
    } finally { instance.unmount(); }
  });
  it("renders the real workspace, agent deck, and terminal surface", async () => {
    const state = { ...testState(), machines: [] };
    const connection = new FakeConnection(state);
    const instance = render(<App connection={connection} />);
    await flushApp();

    const frame = instance.lastFrame() ?? "";
    const lines = frame.split("\n");
    // Shepherd's brand and agent status frame the active workspace and panes.
    expect(lines[0]).toMatch(/^ ◆ SHEPHERD +│ +review/);
    expect(lines[1]).toMatch(/^ SPACES +1 +│/);
    expect(frame).toContain("production");
    expect(frame).toContain(" AGENTS 1");
    expect(frame).toContain("× 1 NEEDS YOU");
    expect(frame).toContain("claude");
    expect(frame).toContain("hello agent");
    expect(frame).toContain("alpha");
    expect(frame).toMatch(/│╭ shell ─+╮╭ claude ─+ × BLOCKED ╮/);
    expect(frame).not.toContain("connecting to Shepherd");

    instance.unmount();
  });

  it("shows saved machines with nested remote workspaces in the sidebar", async () => {
    const state = testState();
    state.machines.push({
      ...state.machines[0]!,
      id: "m2",
      label: "gpu box",
      status: "reconnecting",
      reachable: false,
      remote: null,
    });
    const connection = new FakeConnection(state);
    const instance = render(<App connection={connection} />);
    await flushApp();

    const lines = (instance.lastFrame() ?? "").split("\n");
    expect(lines[0]).toMatch(/^ ◆ SHEPHERD +│/);
    expect(lines[1]).toMatch(/^ MACHINES +3 +│/);
    const localRow = lines.findIndex((line) => /^ ▾ Local/.test(line));
    const edgeRow = lines.findIndex((line) => /^ ▾ edge +● /.test(line));
    const remoteRow = lines.findIndex((line) => line.includes("remote-api"));
    const gpuRow = lines.findIndex((line) => /^ ▾ gpu box +◐ +│/.test(line));
    expect(localRow).toBeGreaterThan(0);
    expect(lines.findIndex((line) => line.includes("production"))).toBeGreaterThan(localRow);
    expect(edgeRow).toBeGreaterThan(localRow);
    expect(remoteRow).toBe(edgeRow + 1);
    expect(gpuRow).toBeGreaterThan(remoteRow);

    // Selecting the remote workspace shows its panes.
    instance.stdin.write(`\u001b[<0;4;${remoteRow + 1}M`);
    instance.stdin.write(`\u001b[<0;4;${remoteRow + 1}m`);
    await flushApp();
    expect(instance.lastFrame() ?? "").toContain("edge · remote-api");
    expect(instance.lastFrame() ?? "").toContain("remote pane output");
    expect(connection.requests).toContainEqual({
      type: "machine.pane-read",
      labelOrId: "edge",
      paneId: "p9",
      rows: 20,
      source: "recent-unwrapped",
    });

    // The arrow collapses a machine's workspaces.
    instance.stdin.write(`\u001b[<0;2;${edgeRow + 1}M`);
    instance.stdin.write(`\u001b[<0;2;${edgeRow + 1}m`);
    await flushApp();
    const collapsed = (instance.lastFrame() ?? "").split("\n");
    expect(collapsed.some((line) => /^ ▸ edge/.test(line))).toBe(true);
    expect(collapsed.some((line) => line.startsWith(" ● remote-api") || line.startsWith(" ○ remote-api")))
      .toBe(false);

    // Local goes back to local panes.
    instance.stdin.write(`\u001b[<0;5;${localRow + 1}M`);
    instance.stdin.write(`\u001b[<0;5;${localRow + 1}m`);
    await flushApp();
    expect(instance.lastFrame() ?? "").not.toContain("edge · remote-api");
    instance.unmount();
  });

  it("shows reported metadata and the active agent view", async () => {
    const state = testState();
    const pane = state.panes.find((entry) => entry.id === "p2")!;
    pane.metadataTitle = "Fix bug";
    pane.displayAgent = "Pi";
    state.agentView = { source: "test", label: "Busy", filter: null, sort: [] };
    const connection = new FakeConnection(state);
    const instance = render(<App connection={connection} />);
    await flushApp();

    const frame = instance.lastFrame() ?? "";
    expect(frame).toMatch(/╭ Fix bug ─+ × BLOCKED ╮/);
    expect(frame).toMatch(/ AGENTS 1 +Busy/);
    expect(frame).toContain("   Pi");

    instance.unmount();
  });

  it("sizes and snapshots only the visible pane while zoomed", async () => {
    const state = {
      ...testState(),
      focusedPaneId: "p2",
    };
    state.tabs[0].zoomedPaneId = "p2";
    state.workspaces[0].tabs[0].zoomedPaneId = "p2";
    const connection = new FakeConnection(state);
    const instance = render(<App connection={connection} />);
    await flushApp();

    const subscribed = connection.requests
      .filter((request) => request.type === "surface.subscribe")
      .map((request) => request.type === "surface.subscribe"
        ? request.panes.map((pane) => pane.paneId)
        : []);
    expect(subscribed.at(-1)).toEqual(["p2"]);

    instance.unmount();
  });

  it("opens the plugin picker and invokes the selected action", async () => {
    const state = testState();
    const connection = new FakeConnection(state);
    const instance = render(<App connection={connection} />);
    await flushApp();

    instance.stdin.write("");
    await flushApp();
    instance.stdin.write("a");
    await flushApp();
    expect(instance.lastFrame() ?? "").toContain("plugin actions");

    instance.stdin.write("\r");
    await flushApp();
    expect(connection.requests).toContainEqual({
      type: "plugin.action-invoke",
      pluginId: "example.tools",
      actionId: "status",
    });

    instance.unmount();
  });

  it("refreshes saved machines from the UI", async () => {
    const connection = new FakeConnection(testState());
    const instance = render(<App connection={connection} />);
    await flushApp();

    instance.stdin.write("");
    await flushApp();
    instance.stdin.write("M");
    await flushApp();

    expect(connection.requests).toContainEqual({
      type: "machine.refresh",
      labelOrId: "edge",
    });
    instance.unmount();
  });

  it("focuses panes and scrolls with SGR mouse input", async () => {
    const connection = new FakeConnection(testState());
    const instance = render(<App connection={connection} />);
    await flushApp();

    instance.stdin.write("[<0;31;6M");
    await flushApp();
    instance.stdin.write("[<0;31;6m");
    await flushApp();
    instance.stdin.write("[<64;31;6M");
    await flushApp();

    expect(connection.requests).toContainEqual({
      type: "pane.focus",
      paneId: "p1",
    });
    expect(connection.requests).toContainEqual({
      type: "surface.scroll",
      paneId: "p1",
      lines: -3,
    });
    instance.unmount();
  });

  it("keeps prefix keyboard mode usable after mouse input", async () => {
    const connection = new FakeConnection(testState());
    const instance = render(<App connection={connection} />);
    await flushApp();

    instance.stdin.write("[<0;70;6M");
    await flushApp();
    instance.stdin.write("");
    await flushApp();
    instance.stdin.write("q");
    await flushApp();

    expect(connection.closed).toBe(true);
    instance.unmount();
  });

  it("resizes splits by dragging mouse split borders", async () => {
    const connection = new FakeConnection(testState());
    const instance = render(<App connection={connection} />);
    await flushApp();

    instance.stdin.write("[<0;64;6M");
    await flushApp();
    instance.stdin.write("[<32;70;6M");
    await flushApp();
    instance.stdin.write("[<0;70;6m");
    await flushApp();

    const resize = connection.requests.find((request) =>
      request.type === "pane.resize-layout"
    ) as { paneId: string; delta: number } | undefined;
    expect(resize).toMatchObject({ paneId: "p1" });
    expect(resize?.delta).toBeGreaterThan(0.07);
    expect(resize?.delta).toBeLessThan(0.09);
    instance.unmount();
  });

  it("swaps panes when one pane is dragged onto another", async () => {
    const connection = new FakeConnection(testState());
    const instance = render(<App connection={connection} />);
    await flushApp();

    instance.stdin.write("[<0;31;2M");
    await flushApp();
    instance.stdin.write("[<32;71;11M");
    await flushApp();
    expect(instance.lastFrame() ?? "").toContain("✓ SWAP shell");
    instance.stdin.write("[<0;71;11m");
    await flushApp();
    expect(instance.lastFrame() ?? "").not.toContain("✓ SWAP shell");

    expect(connection.requests).toContainEqual({
      type: "pane.focus",
      paneId: "p1",
    });
    expect(connection.requests).toContainEqual({
      type: "pane.swap",
      paneId: "p1",
      targetPaneId: "p2",
    });
    instance.unmount();
  });

  it("cancels a pane drag with Escape", async () => {
    const connection = new FakeConnection(testState());
    const instance = render(<App connection={connection} />);
    await flushApp();

    instance.stdin.write("\u001b[<0;31;2M");
    instance.stdin.write("\u001b[<32;71;11M");
    await flushApp();
    expect(instance.lastFrame() ?? "").toContain("✓ SWAP shell");

    instance.stdin.write("\u001b");
    await flushApp();
    instance.stdin.write("\u001b[<0;71;11m");
    await flushApp();
    expect(instance.lastFrame() ?? "").not.toContain("✓ SWAP shell");
    expect(connection.requests.some((request) => request.type === "pane.swap")).toBe(false);
    instance.unmount();
  });

  it("shows a drop preview while moving a workspace", async () => {
    const state = testState();
    state.workspaces.push({ ...state.workspaces[0]!, id: "w2", name: "staging" });
    const connection = new FakeConnection(state);
    const instance = render(<App connection={connection} />);
    await flushApp();

    const lines = (instance.lastFrame() ?? "").split("\n");
    const from = lines.findIndex((line) => line.includes("production"));
    const to = lines.findIndex((line) => line.includes("staging"));
    expect(from).toBeGreaterThan(1);
    expect(to).toBeGreaterThan(1);

    instance.stdin.write(`\u001b[<0;4;${from + 1}M`);
    await flushApp();
    instance.stdin.write(`\u001b[<32;4;${to + 1}M`);
    await flushApp();
    expect(instance.lastFrame() ?? "").toContain("✓ MOVE production");
    instance.stdin.write(`\u001b[<0;4;${to + 1}m`);
    await flushApp();
    expect(connection.requests).toContainEqual({
      type: "workspace.move",
      workspaceId: "w1",
      insertIndex: 1,
    });
    instance.unmount();
  });

  it("selects terminal text by dragging and copies it on release", async () => {
    const connection = new FakeConnection(testState());
    const copied: string[] = [];
    const instance = render(
      <App
        connection={connection}
        copyText={async (text) => {
          copied.push(text);
        }}
      />,
    );
    await flushApp();

    instance.stdin.write("[<0;28;3M");
    await flushApp();
    instance.stdin.write("[<32;31;4M");
    await flushApp();
    instance.stdin.write("[<32;32;5M");
    await flushApp();
    instance.stdin.write("[<0;32;5m");
    await flushApp();

    expect(copied).toEqual(["alpha\nbeta\ngamma"]);
    instance.unmount();
  });

  it("selects and yanks text in keyboard copy mode", async () => {
    const connection = new FakeConnection(testState());
    const copied: string[] = [];
    const instance = render(
      <App
        connection={connection}
        copyText={async (text) => {
          copied.push(text);
        }}
      />,
    );
    await flushApp();

    instance.stdin.write("");
    await flushApp();
    instance.stdin.write("[");
    await flushApp();
    expect(instance.lastFrame() ?? "").toContain("COPY");

    for (const key of ["v", "e", "y"]) {
      instance.stdin.write(key);
      await flushApp();
    }
    expect(copied).toEqual(["hello"]);
    expect(instance.lastFrame() ?? "").not.toContain("COPY");
    expect(connection.requests).toContainEqual({
      type: "surface.scroll_to",
      paneId: "p2",
      top: null,
    });
    instance.unmount();
  });

  it("runs Shepherd's default prefix bindings", async () => {
    const connection = new FakeConnection(testState());
    const instance = render(<App connection={connection} />);
    await flushApp();

    const press = async (key: string) => {
      instance.stdin.write("");
      await flushApp();
      instance.stdin.write(key);
      await flushApp();
    };
    await press("v");
    await press("-");
    await press("h");
    await press("L");
    await press("");
    await press("?");
    expect(instance.lastFrame() ?? "").toContain("keybindings");
    instance.stdin.write("\x1b");
    await flushApp();

    expect(connection.requests).toEqual(expect.arrayContaining([
      { type: "pane.create", direction: "right" },
      { type: "pane.create", direction: "down" },
      { type: "pane.focus_direction", direction: "left" },
      { type: "pane.swap", direction: "right" },
      { type: "pane.input", paneId: "p2", data: "" },
    ]));
    instance.unmount();
  });

  it("asks before closing the last tab", async () => {
    const connection = new FakeConnection(testState());
    const instance = render(<App connection={connection} />);
    await flushApp();

    instance.stdin.write("");
    await flushApp();
    instance.stdin.write("X");
    await flushApp();
    expect(instance.lastFrame() ?? "").toContain("Close the last tab?");
    expect(connection.requests.some((request) => request.type === "tab.close"))
      .toBe(false);
    instance.stdin.write("y");
    await flushApp();
    expect(connection.requests).toContainEqual({ type: "tab.close", tabId: "t1" });
    instance.unmount();
  });

  it("opens the Go to navigator, filters, and jumps to a pane", async () => {
    const connection = new FakeConnection(testState());
    const instance = render(<App connection={connection} />);
    await flushApp();

    instance.stdin.write("");
    await flushApp();
    instance.stdin.write("g");
    await flushApp();
    let frame = instance.lastFrame() ?? "";
    expect(frame).toContain("Go to");
    expect(frame).toContain("2 terminals");
    expect(frame).toContain("◆");

    instance.stdin.write("/");
    await flushApp();
    for (const key of "shell") {
      instance.stdin.write(key);
      await flushApp();
    }
    frame = instance.lastFrame() ?? "";
    expect(frame).toContain("/ shell");
    expect(frame).toContain("1 terminal ");

    instance.stdin.write("\r");
    await flushApp();
    expect(connection.requests).toContainEqual({ type: "pane.focus", paneId: "p1" });
    expect(instance.lastFrame() ?? "").not.toContain("Go to");
    instance.unmount();
  });

  it("opens a pane context menu on right click", async () => {
    const connection = new FakeConnection(testState());
    const instance = render(<App connection={connection} />);
    await flushApp();

    instance.stdin.write("[<2;31;6M");
    await flushApp();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("Rename pane");
    expect(frame).toContain("Swap with focused pane");
    expect(frame).toContain("Send right-clicks to pane");

    instance.stdin.write("j");
    await flushApp();
    instance.stdin.write("j");
    await flushApp();
    instance.stdin.write("\r");
    await flushApp();
    expect(connection.requests).toContainEqual({
      type: "pane.swap",
      paneId: "p2",
      targetPaneId: "p1",
    });
    instance.unmount();
  });

  it("runs popup commands as a session-modal terminal", async () => {
    const connection = new FakeConnection(testState());
    const config = defaultLoadedConfig();
    config.config.keys.commands.push({
      key: "prefix+alt+g",
      type: "popup",
      command: "lazygit",
      description: "lazygit",
      width: "80%",
      height: "80%",
    });
    config.keymap.commandsPrefixed.set("alt+g", 0);
    const instance = render(<App connection={connection} config={config} />);
    await flushApp();

    instance.stdin.write("");
    await flushApp();
    instance.stdin.write("g");
    await flushApp();
    expect(connection.requests).toContainEqual({
      type: "command.run",
      command: "lazygit",
      commandType: "popup",
    });
    expect(instance.lastFrame() ?? "").toContain("lazygit");

    instance.stdin.write("");
    await flushApp();
    await new Promise((resolve) => setImmediate(resolve));
    expect(connection.requests).toContainEqual({
      type: "pane.input",
      paneId: "p77",
      data: "",
    });

    connection.eventHandler?.({
      event: "popup.closed",
      data: { paneId: "p77" },
      emittedAt: "2026-09-23T00:00:00.000Z",
    });
    await flushApp();
    expect(instance.lastFrame() ?? "").not.toContain("┌─ lazygit");
    instance.unmount();
  });

  it("changes settings from the settings overlay", async () => {
    const connection = new FakeConnection(testState());
    const instance = render(<App connection={connection} />);
    await flushApp();

    instance.stdin.write("");
    await flushApp();
    instance.stdin.write("s");
    await flushApp();
    let frame = instance.lastFrame() ?? "";
    expect(frame).toContain("Settings");
    expect(frame).toMatch(/✓ shepherd/);

    instance.stdin.write("\x1b[C");
    await flushApp();
    instance.stdin.write("j");
    await flushApp();
    instance.stdin.write("\r");
    await flushApp();
    frame = instance.lastFrame() ?? "";
    expect(frame).toMatch(/✓ symbols/);
    // The sidebar now uses symbol indicators (× for the blocked agent).
    expect(frame).toContain("×");
    instance.unmount();
  });

  it("forwards mouse input to apps that track the mouse", async () => {
    const state = testState();
    const p1 = state.panes.find((pane) => pane.id === "p1");
    if (p1) {
      p1.modes = {
        applicationCursorKeys: false,
        bracketedPaste: false,
        mouseTracking: "vt200",
        sendFocus: false,
        alternateScreen: true,
      };
    }
    const connection = new FakeConnection(state);
    const instance = render(<App connection={connection} />);
    await flushApp();

    instance.stdin.write("[<0;30;4M");
    await flushApp();
    instance.stdin.write("[<0;30;4m");
    await flushApp();
    instance.stdin.write("[<64;30;4M");
    await flushApp();

    const mouse = connection.requests.filter((request) =>
      request.type === "pane.mouse"
    );
    expect(mouse).toEqual([
      expect.objectContaining({ paneId: "p1", col: 2, row: 1, action: "press" }),
      expect.objectContaining({ paneId: "p1", col: 2, row: 1, action: "release" }),
      expect.objectContaining({ paneId: "p1", button: "wheel", action: "up" }),
    ]);
    expect(connection.requests.some((request) => request.type === "surface.scroll"))
      .toBe(false);
    instance.unmount();
  });

  it("passes modified right-clicks through to mouse-tracking apps", async () => {
    const state = testState();
    const p1 = state.panes.find((pane) => pane.id === "p1")!;
    p1.modes = {
      applicationCursorKeys: false,
      bracketedPaste: false,
      mouseTracking: "vt200",
      sendFocus: false,
      alternateScreen: true,
    };
    const connection = new FakeConnection(state);
    const config = defaultLoadedConfig();
    config.config.ui.right_click_passthrough_modifier = { ctrl: true, alt: false, super: false };
    const instance = render(<App connection={connection} config={config} />);
    await flushApp();

    instance.stdin.write("\x1b[<18;30;4M");
    await flushApp();
    instance.stdin.write("\x1b[<18;30;4m");
    await flushApp();

    const mouse = connection.requests.filter((request) => request.type === "pane.mouse");
    expect(mouse).toEqual([
      expect.objectContaining({ paneId: "p1", button: "right", action: "press", ctrl: false }),
      expect.objectContaining({ paneId: "p1", action: "release", ctrl: false }),
    ]);
    expect(instance.lastFrame()).not.toContain("Split right");
    instance.unmount();
  });

  it("notifies about background agents with toasts", async () => {
    const state = testState();
    const connection = new FakeConnection(state);
    const config = defaultLoadedConfig();
    config.config.ui.toast.delay_seconds = 0;
    config.config.ui.sound.enabled = false;
    const instance = render(<App connection={connection} config={config} />);
    await flushApp();

    const setStatus = (status: "blocked" | "done", previous: string) => {
      const pane = state.panes.find((entry) => entry.id === "p2");
      if (pane) pane.status = status;
      connection.eventHandler?.({
        event: "agent.status.changed",
        data: { paneId: "p2", agent: "claude", previous, status },
        emittedAt: "2026-09-23T00:00:00.000Z",
      });
    };

    // The pane is on screen and the terminal has focus: no toast.
    setStatus("blocked", "working");
    await flushApp();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flushApp();
    expect(instance.lastFrame() ?? "").not.toContain("needs attention");

    // Hide the agent behind a zoomed shell: the completion is announced.
    state.workspaces[0]!.tabs[0]!.zoomedPaneId = "p1";
    state.focusedPaneId = "p1";
    connection.eventHandler?.({ event: "state.changed", data: {}, emittedAt: "" });
    await flushApp();
    setStatus("done", "blocked");
    await flushApp();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flushApp();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("claude ready for review");
    expect(frame).toContain("production · 1");
    expect(frame.split("\n")[0]).toContain("claude ready for review");
    expect(frame).toContain("alpha");
    instance.stdin.write("hello");
    await flushApp();
    expect(connection.requests).toContainEqual({ type: "pane.input", paneId: "p1", data: "hello" });

    // prefix+o jumps to the pane that notified.
    instance.stdin.write("\x02");
    await flushApp();
    instance.stdin.write("o");
    await flushApp();
    expect(connection.requests).toContainEqual({ type: "pane.focus", paneId: "p2" });
    instance.unmount();
  });

  it.each(["blocked", "done"] as const)("delivers %s alerts after a slow state refresh", async (status) => {
    const state = testState();
    state.workspaces[0]!.tabs[0]!.zoomedPaneId = "p1";
    state.focusedPaneId = "p1";
    state.panes[1]!.status = "working";
    const connection = new FakeConnection(state);
    const config = defaultLoadedConfig();
    config.config.ui.toast.delay_seconds = 0;
    config.config.ui.sound.enabled = false;
    const instance = render(<App connection={connection} config={config} />);
    const request = connection.request.bind(connection);
    let release: (() => void) | undefined;
    try {
      await flushApp();
      const refresh = new Promise<void>((resolve) => { release = resolve; });
      vi.spyOn(connection, "request").mockImplementation(async (message) => {
        const response = request(message);
        if (message.type === "state.get") await refresh;
        return response;
      });
      state.panes[1]!.status = status;
      connection.eventHandler?.({
        event: "agent.status.changed",
        data: { paneId: "p2", agent: "claude", previous: "working", status },
        emittedAt: "",
      });
      // Delivery becomes due before the new status reaches the UI.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await flushApp();
      const title = status === "blocked" ? "claude needs attention" : "claude ready for review";
      expect(instance.lastFrame()).not.toContain(title);
      release!();
      await vi.waitFor(() => expect(instance.lastFrame()).toContain(title));
    } finally {
      release?.();
      instance.unmount();
    }
  });

  it.each([
    { focused: true, position: "bar" as const },
    { focused: false, position: "bar" as const },
    { focused: false, position: "bottom-right" as const },
  ])("keeps a single visible Codex pane quiet ($focused, $position)", async ({ focused, position }) => {
    const state = testState();
    state.panes = [{ ...state.panes[1]!, agent: "codex", title: "codex", status: "working" }];
    state.workspaces[0]!.tabs[0]!.layout = { kind: "pane", paneId: "p2" };
    const connection = new FakeConnection(state);
    const config = defaultLoadedConfig();
    config.config.ui.toast.delay_seconds = 0;
    config.config.ui.toast.position = position;
    const sound = vi.spyOn(notifications, "playSound").mockImplementation(() => {});
    const instance = render(<App connection={connection} config={config} />);
    try {
      await flushApp();
      if (!focused) instance.stdin.write("\x1b[O");
      await flushApp();
      state.panes[0]!.status = "blocked";
      connection.eventHandler?.({
        event: "agent.status.changed",
        data: { paneId: "p2", agent: "codex", previous: "working", status: "blocked" },
        emittedAt: "",
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      await flushApp();
      expect(instance.frames.join("\n")).not.toContain("codex needs attention");
      expect(instance.lastFrame()).toContain("hello agent");
      expect(sound).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
      sound.mockRestore();
    }
  });

  it("checks current visibility before delivering a delayed alert and dismisses it when seen", async () => {
    const state = testState();
    state.workspaces[0]!.tabs[0]!.zoomedPaneId = "p1";
    state.focusedPaneId = "p1";
    const connection = new FakeConnection(state);
    const config = defaultLoadedConfig();
    config.config.ui.toast.delay_seconds = 0.1;
    config.config.ui.sound.enabled = false;
    const instance = render(<App connection={connection} config={config} />);
    const status = () => connection.eventHandler?.({
      event: "agent.status.changed",
      data: { paneId: "p2", agent: "codex", previous: "working", status: "blocked" },
      emittedAt: "",
    });
    const zoom = async (paneId: string) => {
      state.workspaces[0]!.tabs[0]!.zoomedPaneId = paneId;
      state.focusedPaneId = paneId;
      connection.eventHandler?.({ event: "state.changed", data: {}, emittedAt: "" });
      await flushApp();
    };
    try {
      await flushApp();
      status();
      await flushApp();
      await zoom("p2");
      await new Promise((resolve) => setTimeout(resolve, 150));
      await flushApp();
      expect(instance.frames.join("\n")).not.toContain("codex needs attention");

      await zoom("p1");
      status();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await flushApp();
      expect(instance.lastFrame()).toContain("codex needs attention");
      await zoom("p2");
      expect(instance.lastFrame()).not.toContain("codex needs attention");
      await zoom("p1");
      expect(instance.lastFrame()).not.toContain("codex needs attention");
    } finally { instance.unmount(); }
  });

  it.each(["top", "bottom", "mobile", "sidebar", "hidden"])("keeps background alerts to one line (%s chrome)", async (layout) => {
    const state = testState();
    state.workspaces[0]!.tabs[0]!.zoomedPaneId = "p1";
    state.focusedPaneId = "p1";
    const connection = new FakeConnection(state);
    const config = defaultLoadedConfig();
    config.config.ui.toast.delay_seconds = 0;
    config.config.ui.sound.enabled = false;
    config.config.ui.tab_bar_position = layout === "bottom" ? "bottom" : "top";
    config.config.ui.mobile_width_threshold = layout === "mobile" ? 100 : 0;
    config.config.ui.hide_tab_bar_when_single_tab = layout === "sidebar" || layout === "hidden";
    config.config.ui.sidebar_start_collapsed = layout === "hidden";
    config.config.ui.sidebar_collapsed_mode = "hidden";
    const instance = render(<App connection={connection} config={config} />);
    try {
      await flushApp();
      const before = (instance.lastFrame() ?? "").split("\n");
      connection.eventHandler?.({
        event: "agent.status.changed",
        data: { paneId: "p2", agent: "codex", previous: "working", status: "blocked" }, emittedAt: "",
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      await flushApp();
      const after = (instance.lastFrame() ?? "").split("\n");
      const row = layout === "bottom" || layout === "sidebar" ? after.length - 1
        : layout === "mobile" ? 1 : 0;
      expect(after[row]).toContain("codex needs attention");
      expect(after.filter((_, index) => index !== row)).toEqual(before.filter((_, index) => index !== row));
      if (layout === "mobile") expect(after[row]).toContain("switch");
      const col = after[row]!.indexOf("codex needs attention") + 1;
      instance.stdin.write(`\x1b[<0;${col};${row + 1}M`);
      await flushApp();
      expect(connection.requests).toContainEqual({ type: "pane.focus", paneId: "p2" });
      expect(instance.lastFrame()).not.toContain("codex needs attention");
    } finally { instance.unmount(); }
  });

  it("cancels superseded status alerts instead of delivering duplicates", async () => {
    const state = testState();
    state.workspaces[0]!.tabs[0]!.zoomedPaneId = "p1";
    state.focusedPaneId = "p1";
    const connection = new FakeConnection(state);
    const config = defaultLoadedConfig();
    config.config.ui.toast.delay_seconds = 0.05;
    const sound = vi.spyOn(notifications, "playSound").mockImplementation(() => {});
    const instance = render(<App connection={connection} config={config} />);
    const report = async (status: "blocked" | "working", previous: string) => {
      state.panes[1]!.status = status;
      connection.eventHandler?.({
        event: "agent.status.changed",
        data: { paneId: "p2", agent: "codex", previous, status }, emittedAt: "",
      });
      await flushApp();
    };
    try {
      await flushApp();
      await report("blocked", "working");
      await report("working", "blocked");
      await report("blocked", "working");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await flushApp();
      expect(sound).toHaveBeenCalledTimes(1);
      expect(instance.lastFrame()).toContain("codex needs attention");
      await report("working", "blocked");
      expect(instance.lastFrame()).not.toContain("codex needs attention");
    } finally {
      instance.unmount();
      sound.mockRestore();
    }
  });

  it("still delivers native alerts while away and treats typing as renewed focus", async () => {
    const state = testState();
    const connection = new FakeConnection(state);
    const config = defaultLoadedConfig();
    config.config.ui.toast.delivery = "system";
    config.config.ui.toast.delay_seconds = 0;
    config.config.ui.sound.enabled = false;
    const system = vi.spyOn(notifications, "systemNotification").mockImplementation(() => {});
    const instance = render(<App connection={connection} config={config} />);
    const report = async (status: "blocked" | "done", previous: string) => {
      state.panes[1]!.status = status;
      connection.eventHandler?.({
        event: "agent.status.changed",
        data: { paneId: "p2", agent: "codex", previous, status }, emittedAt: "",
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      await flushApp();
    };
    try {
      await flushApp();
      instance.stdin.write("\x1b[O");
      await flushApp();
      await report("blocked", "working");
      expect(system).toHaveBeenCalledTimes(1);
      expect(system).toHaveBeenCalledWith("codex needs attention", "production · 1");
      instance.stdin.write("x");
      await flushApp();
      await report("done", "blocked");
      expect(system).toHaveBeenCalledTimes(1);
    } finally {
      instance.unmount();
      system.mockRestore();
    }
  });

  it("reads and prompts remote agents through the unified UI", async () => {
    const connection = new FakeConnection(testState());
    const instance = render(<App connection={connection} />);
    await flushApp();

    instance.stdin.write("");
    await flushApp();
    instance.stdin.write("A");
    await flushApp();
    expect(instance.lastFrame() ?? "").toContain("remote agents");

    instance.stdin.write("\r");
    await flushApp();
    expect(connection.requests).toContainEqual({
      type: "machine.agent-read",
      labelOrId: "edge",
      target: "p9",
      rows: 80,
      source: "recent-unwrapped",
    });
    expect(instance.lastFrame() ?? "").toContain("remote claude output");

    instance.stdin.write("\r");
    await flushApp();
    for (const character of "summarize the failing test") {
      instance.stdin.write(character);
      await flushApp();
    }
    instance.stdin.write("\r");
    await flushApp();
    expect(connection.requests).toContainEqual({
      type: "machine.agent-prompt",
      labelOrId: "edge",
      target: "p9",
      prompt: "summarize the failing test",
      timeoutMs: 120_000,
    });

    instance.unmount();
  });

  it("reads and writes remote pane surfaces from the unified UI", async () => {
    const connection = new FakeConnection(testState());
    const instance = render(<App connection={connection} />);
    await flushApp();

    instance.stdin.write("");
    await flushApp();
    instance.stdin.write("E");
    await flushApp();
    expect(instance.lastFrame() ?? "").toContain("remote pane surfaces");

    instance.stdin.write("\r");
    await flushApp();
    expect(connection.requests).toContainEqual({
      type: "machine.pane-read",
      labelOrId: "edge",
      paneId: "p9",
      rows: 80,
      source: "recent-unwrapped",
    });
    expect(instance.lastFrame() ?? "").toContain("remote pane output");
    const initialReads = connection.requests.filter((request) =>
      request.type === "machine.pane-read"
    ).length;
    await new Promise((resolve) => setTimeout(resolve, 850));
    expect(connection.requests.filter((request) =>
      request.type === "machine.pane-read"
    ).length).toBeGreaterThan(initialReads);

    instance.stdin.write("\r");
    await flushApp();
    for (const character of "git status --short") {
      instance.stdin.write(character);
      await flushApp();
    }
    instance.stdin.write("\r");
    await flushApp();
    expect(connection.requests).toContainEqual({
      type: "machine.pane-input",
      labelOrId: "edge",
      paneId: "p9",
      data: "git status --short",
    });

    instance.unmount();
  });

  it("shows every remote pane in a streaming tiled dashboard", async () => {
    const connection = new FakeConnection(testState());
    const instance = render(<App connection={connection} />);
    await flushApp();

    instance.stdin.write("");
    await flushApp();
    instance.stdin.write("B");
    await flushApp();

    expect(instance.lastFrame() ?? "").toContain("streaming remote panes");
    expect(instance.lastFrame() ?? "").toContain("remote pane output");
    expect(connection.requests).toContainEqual({
      type: "machine.pane-read",
      labelOrId: "edge",
      paneId: "p9",
      rows: 20,
      source: "recent-unwrapped",
    });

    instance.stdin.write("");
    await flushApp();
    expect(instance.lastFrame() ?? "").not.toContain("streaming remote panes");
    instance.unmount();
  });
});

describe("phone-width layout", () => {
  const mobileConfig = () => {
    const config = defaultLoadedConfig();
    // The test terminal is 100 columns wide.
    config.config.ui.mobile_width_threshold = 100;
    return config;
  };
  const withSecondWorkspace = () => {
    const state = testState();
    state.workspaces.push({
      ...state.workspaces[0]!,
      id: "w2",
      name: "staging",
      tabs: [{ ...state.workspaces[0]!.tabs[0]!, id: "t9" }],
    });
    return state;
  };

  it("swaps the sidebar and tab bar for a status header and full-width panes", async () => {
    const connection = new FakeConnection(testState());
    const instance = render(<App connection={connection} config={mobileConfig()} />);
    await flushApp();

    const lines = (instance.lastFrame() ?? "").split("\n");
    expect(lines[0]).toMatch(/^ × production +tab review +│/);
    expect(lines[1]).toMatch(/^ × 1 blocked +│ +switch/);
    expect(lines[2]).toMatch(/^╭ shell ─+╮╭ claude ─+ × BLOCKED ╮$/);
    expect(lines.join("\n")).not.toContain(" spaces");
    const subscribed = connection.requests.filter((request) => request.type === "surface.subscribe");
    expect(subscribed.at(-1)).toMatchObject({
      // 50 columns each, less two borders and the scrollbar gutter.
      panes: [{ paneId: "p1", cols: 47, rows: 36 }, { paneId: "p2", cols: 47, rows: 36 }],
    });

    // Clicks under the header land in the panes at their new offsets.
    instance.stdin.write("\u001b[<0;10;5M");
    instance.stdin.write("\u001b[<0;10;5m");
    await flushApp();
    expect(connection.requests).toContainEqual({ type: "pane.focus", paneId: "p1" });
    instance.unmount();
  });

  it("opens the switcher from the header and activates a row", async () => {
    const connection = new FakeConnection(withSecondWorkspace());
    const instance = render(<App connection={connection} config={mobileConfig()} />);
    await flushApp();

    instance.stdin.write("\u001b[<0;96;2M");
    instance.stdin.write("\u001b[<0;96;2m");
    await flushApp();
    const frame = instance.lastFrame() ?? "";
    for (const expected of [
      " switch", "close", " agents", " spaces", "+ new workspace", " tabs", "+ new tab",
      " menu", "detach",
    ]) {
      expect(frame).toContain(expected);
    }
    expect(frame).not.toContain("hello agent");
    expect(frame).not.toContain("NAVIGATE");

    // The spaces entry (the agents section also names the workspace).
    const lines = frame.split("\n");
    const staging = lines.findIndex((line, index) =>
      line.includes("staging") && (lines[index + 1] ?? "").includes("shell ·")
    );
    instance.stdin.write(`\u001b[<0;10;${staging + 2}M`);
    instance.stdin.write(`\u001b[<0;10;${staging + 2}m`);
    await flushApp();
    expect(connection.requests).toContainEqual({ type: "workspace.select", workspaceId: "w2" });
    expect(instance.lastFrame() ?? "").toContain("hello agent");
    instance.unmount();
  });

  it("navigates the switcher from the keyboard without wrapping", async () => {
    const connection = new FakeConnection(withSecondWorkspace());
    const instance = render(<App connection={connection} config={mobileConfig()} />);
    await flushApp();

    instance.stdin.write("\u0002");
    await flushApp();
    instance.stdin.write("w");
    await flushApp();
    expect(instance.lastFrame() ?? "").toContain("+ new workspace");
    // Down past the last workspace stays on it.
    instance.stdin.write("\u001b[B");
    await flushApp();
    instance.stdin.write("\u001b[B");
    await flushApp();
    instance.stdin.write("\r");
    await flushApp();
    expect(connection.requests).toContainEqual({ type: "workspace.select", workspaceId: "w2" });
    expect(instance.lastFrame() ?? "").not.toContain("+ new workspace");
    instance.unmount();
  });
});

describe("pane_gaps = false", () => {
  const gaplessConfig = () => {
    const config = defaultLoadedConfig();
    config.config.ui.pane_gaps = false;
    return config;
  };

  it("draws one shared divider between neighbouring panes", async () => {
    const connection = new FakeConnection(testState());
    const instance = render(<App connection={connection} config={gaplessConfig()} />);
    await flushApp();

    const frame = instance.lastFrame() ?? "";
    expect(frame).toMatch(/│┌ shell ─+┬ claude ─+ × BLOCKED ┐/);
    expect(frame).toMatch(/│└─+┴─+┘/);
    // The left pane gives up only its right border: 37 columns less one
    // border and the scrollbar gutter; the right pane keeps both borders.
    const subscribed = connection.requests.filter((request) => request.type === "surface.subscribe");
    expect(subscribed.at(-1)).toMatchObject({
      panes: [{ paneId: "p1", cols: 35 }, { paneId: "p2", cols: 34 }],
    });
    instance.unmount();
  });

  it("drags the shared divider and leaves the cell beside it to the pane", async () => {
    const connection = new FakeConnection(testState());
    const instance = render(<App connection={connection} config={gaplessConfig()} />);
    await flushApp();

    // Sidebar 26 wide, left pane 37 wide: the divider is column 64.
    instance.stdin.write("\u001b[<0;64;6M");
    instance.stdin.write("\u001b[<32;66;6M");
    instance.stdin.write("\u001b[<0;66;6m");
    await flushApp();
    expect(connection.requests.some((request) => request.type === "pane.resize-layout"))
      .toBe(true);
    expect(connection.requests).not.toContainEqual({ type: "pane.focus", paneId: "p1" });

    instance.stdin.write("\u001b[<0;63;6M");
    instance.stdin.write("\u001b[<0;63;6m");
    await flushApp();
    expect(connection.requests).toContainEqual({ type: "pane.focus", paneId: "p1" });
    instance.unmount();
  });
});

class FakeConnection {
  readonly requests: ShepherdRequest[] = [];
  closed = false;
  eventHandler?: (event: import("../src/types.js").EventFrame) => void;

  constructor(private readonly state: StateView) {}

  request(request: ShepherdRequest): Promise<unknown> {
    this.requests.push(request);
    if (request.type === "state.get") {
      return Promise.resolve(structuredClone(this.state));
    }
    if (request.type === "pane.text") {
      const lines = request.paneId === "p1"
        ? ["alpha", "beta", "gamma", "", "delta echo"]
        : ["hello agent"];
      return Promise.resolve({
        start: request.start,
        lines: lines.slice(request.start, request.start + request.count),
        total: lines.length,
        baseLine: 0,
      });
    }
    if (request.type === "command.run" && request.commandType === "popup") {
      return Promise.resolve({ paneId: "p77" });
    }
    if (request.type === "pane.search") {
      return Promise.resolve({
        match: request.query === "echo" ? { line: 4, col: 6, length: 4 } : null,
      });
    }
    if (request.type === "surface.subscribe") {
      queueMicrotask(() => {
        for (const pane of request.panes) {
          const lines = pane.paneId === "p1"
            ? ["alpha", "beta", "gamma"].map((text) => [{ text }])
            : [[{ text: "hello agent" }]];
          this.eventHandler?.({
            event: "pane.surface",
            data: {
              paneId: pane.paneId,
              revision: 1,
              cols: pane.cols,
              rows: pane.rows,
              full: true,
              lines: Object.fromEntries(lines.map((line, index) => [index, line])),
              cursor: { x: 0, y: 0, visible: true, shape: "block", blink: false },
              title: "",
              scroll: { offsetFromBottom: 0, maxOffsetFromBottom: 0 },
              modes: {
                applicationCursorKeys: false,
                bracketedPaste: false,
                mouseTracking: "none",
                sendFocus: false,
                alternateScreen: false,
              },
            },
            emittedAt: "2026-09-23T00:00:00.000Z",
          });
        }
      });
      return Promise.resolve({ accepted: true });
    }
    if (request.type === "plugin.action-invoke") {
      return Promise.resolve({
        exitCode: 0,
        stdout: "plugin ready",
        stderr: "",
        timedOut: false,
      });
    }
    if (request.type === "machine.refresh") {
      return Promise.resolve({
        ...this.state.machines[0],
        reachable: true,
      });
    }
    if (request.type === "machine.agent-read") {
      return Promise.resolve({
        machineId: "m1",
        machineLabel: "edge",
        paneId: request.target,
        kind: "read",
        value: "remote claude output",
        exitCode: 0,
      });
    }
    if (request.type === "machine.agent-prompt") {
      return Promise.resolve({
        machineId: "m1",
        machineLabel: "edge",
        paneId: request.target,
        kind: "prompt",
        value: "{\"status\":\"idle\",\"timedOut\":false}",
        exitCode: 0,
      });
    }
    if (request.type === "machine.pane-read") {
      return Promise.resolve({
        machineId: "m1",
        machineLabel: "edge",
        paneId: request.paneId,
        value: "remote pane output",
        exitCode: 0,
      });
    }
    if (request.type === "machine.pane-input") {
      return Promise.resolve({
        machineId: "m1",
        machineLabel: "edge",
        paneId: request.paneId,
        value: "accepted",
        exitCode: 0,
      });
    }
    return Promise.resolve({ accepted: true });
  }

  close(): void {
    this.closed = true;
  }

  setEventHandler(
    handler: ((event: import("../src/types.js").EventFrame) => void) | undefined,
  ): void {
    this.eventHandler = handler;
  }
}

function testState(): StateView {
  return {
    protocolVersion: 1,
    session: "default",
    serverPid: 123,
    activeWorkspaceId: "w1",
    activeTabId: "t1",
    focusedPaneId: "p2",
    stateVersion: 4,
    machines: [{
      id: "m1",
      label: "edge",
      target: "deploy@example.com",
      port: 2222,
      checkedAt: "2026-09-22T00:00:00.000Z",
      reachable: true,
      error: null,
      status: "online",
      enabled: true,
      remoteSession: null,
      remote: {
        serverPid: 4242,
        protocolVersion: 1,
        workspaces: 1,
        tabs: 1,
        paneCount: 1,
        workspaceList: [{
          id: "w1",
          name: "remote-api",
          rootPath: "/srv/api",
          activeTabId: "t1",
          tabs: [{
            id: "t1",
            name: "",
            layout: { kind: "pane", paneId: "p9" },
            zoomedPaneId: null,
          }],
        }],
        activeWorkspaceId: "w1",
        panes: [{
          paneId: "p9",
          title: "claude",
          agent: "claude",
          status: "blocked",
        }],
        agents: [{
          paneId: "p9",
          agent: "claude",
          status: "blocked",
          title: "claude",
        }],
      },
    }],
    plugins: [{
      id: "example.tools",
      name: "Tools",
      version: "0.1.0",
      manifestPath: "/tmp/example/shepherd-plugin.toml",
      root: "/tmp/example",
      enabled: true,
      actions: [{
        id: "status",
        title: "Status",
        command: ["node", "-e", "console.log('plugin ready')"],
      }],
    }],
    workspaces: [{
      id: "w1",
      name: "production",
      rootPath: "/tmp/shepherd",
      activeTabId: "t1",
      tabs: [{
        id: "t1",
        name: "review",
        zoomedPaneId: null,
        layout: {
          kind: "split",
          direction: "right",
          ratio: 0.5,
          first: { kind: "pane", paneId: "p1" },
          second: { kind: "pane", paneId: "p2" },
        },
      }],
    }],
    tabs: [{
      id: "t1",
      name: "review",
      zoomedPaneId: null,
      layout: {
        kind: "split",
        direction: "right",
        ratio: 0.5,
        first: { kind: "pane", paneId: "p1" },
        second: { kind: "pane", paneId: "p2" },
      },
    }],
    panes: [
      {
        id: "p1",
        title: "shell",
        command: null,
        cwd: "/tmp",
        agent: null,
        status: "idle",
        exitCode: null,
        updatedAt: "2026-09-22T00:00:00.000Z",
      },
      {
        id: "p2",
        title: "claude",
        command: "claude",
        cwd: "/tmp",
        agent: "claude",
        status: "blocked",
        exitCode: null,
        updatedAt: "2026-09-22T00:00:00.000Z",
      },
    ],
  };
}

async function flushApp(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
