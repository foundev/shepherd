import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildKeymap,
  comboKey,
  parseBinding,
  parseCombo,
} from "../src/config/keybinds.js";
import { loadConfig, parseConfig } from "../src/config/model.js";
import { decodeKey } from "../src/client/input.js";
import {
  layoutGeometry,
  paneInDirection,
  resizeInDirection,
} from "../src/server/layout.js";
import type { LayoutNode } from "../src/types.js";

describe("key syntax", () => {
  it.each([
    ["ctrl+b", "\x02"],
    ["?", "?"],
    ["[", "["],
    ["minus", "-"],
    ["shift+h", "H"],
    ["H", "H"],
    ["shift+tab", "\x1b[Z"],
    ["tab", "\t"],
    ["esc", "\x1b"],
    ["alt+x", "\x1bx"],
    ["f12", "\x1b[24~"],
    ["ctrl+shift+up", "\x1b[1;6A"],
    ["space", " "],
  ])("%s matches what the terminal sends", (binding, raw) => {
    expect(parseCombo(binding)).toBe(comboKey(decodeKey(raw)));
  });

  it("expands indexed bindings", () => {
    const parsed = parseBinding("prefix+1..9");
    expect(parsed).toHaveLength(9);
    expect(parsed?.[4]).toEqual({ prefix: true, combo: "5", index: 4 });
    expect(parseBinding("alt+1..9")?.[0]).toEqual({
      prefix: false,
      combo: "alt+1",
      index: 0,
    });
  });

  it("rejects malformed bindings", () => {
    expect(parseBinding("prefix+ctrl+")).toBeNull();
    expect(parseBinding("ctrl+nonsense")).toBeNull();
    expect(parseBinding("")).toEqual([]);
  });

  it("builds Shepherd's default prefix keymap", () => {
    const keymap = buildKeymap("ctrl+b", {});
    expect(keymap.prefix).toBe("ctrl+b");
    expect(keymap.prefixed.get("v")?.action).toBe("split_vertical");
    expect(keymap.prefixed.get("-")?.action).toBe("split_horizontal");
    expect(keymap.prefixed.get("shift+h")?.action).toBe("swap_pane_left");
    expect(keymap.prefixed.get("h")?.action).toBe("focus_pane_left");
    expect(keymap.prefixed.get("[")?.action).toBe("copy_mode");
    expect(keymap.prefixed.get("3")).toEqual({ action: "switch_tab", index: 2 });
    expect(keymap.direct.size).toBe(0);
  });
});

describe("config", () => {
  it("defaults notifications to the bar and accepts explicit corner positions", () => {
    expect(parseConfig({}).ui.toast.position).toBe("bar");
    for (const position of ["bar", "bottom-right"]) {
      const diagnostics: string[] = [];
      const config = parseConfig({ ui: { toast: { shepherd: { position } } } }, diagnostics);
      expect(config.ui.toast.position).toBe(position);
      expect(diagnostics).toEqual([]);
    }
  });

  it("applies overrides and reports invalid values", () => {
    const diagnostics: string[] = [];
    const config = parseConfig({
      keys: {
        prefix: "ctrl+a",
        split_vertical: ["prefix+|", "ctrl+alt+v"],
        fullscreen: "prefix+f",
        nonsense: "prefix+y",
      },
      ui: { confirm_close: false, mouse_scroll_lines: 0, status_indicators: "symbols" },
      terminal: { shell_mode: "sometimes" },
    }, diagnostics);
    expect(config.keys.prefix).toBe("ctrl+a");
    expect(config.keys.bindings.split_vertical).toEqual(["prefix+|", "ctrl+alt+v"]);
    expect(config.keys.bindings.zoom).toEqual(["prefix+f"]);
    expect(config.ui.confirm_close).toBe(false);
    expect(config.ui.mouse_scroll_lines).toBe(3);
    expect(config.ui.status_indicators).toBe("symbols");
    expect(config.terminal.shell_mode).toBe("auto");
    expect(diagnostics).toEqual([
      "keys.nonsense: unknown action",
      "terminal.shell_mode: expected one of auto, login, non_login",
      "ui.mouse_scroll_lines: expected an integer from 1 to 100",
    ]);

    const keymap = buildKeymap(config.keys.prefix, config.keys.bindings);
    expect(keymap.prefixed.get("|")?.action).toBe("split_vertical");
    expect(keymap.direct.get("ctrl+alt+v")?.action).toBe("split_vertical");
    expect(keymap.prefixed.get("v")).toBeUndefined();
  });

  it("reads legacy [keys.indexed] modifier combos", () => {
    const diagnostics: string[] = [];
    const config = parseConfig({
      keys: { indexed: { tabs: "alt", workspaces: "ctrl+shift", agents: "x" } },
    }, diagnostics);
    expect(config.keys.bindings.switch_tab).toEqual(["alt+1..9"]);
    expect(diagnostics).toEqual([
      'keys.indexed.agents: invalid indexed keybinding "x"; disabling binding',
    ]);
    const keymap = buildKeymap(config.keys.prefix, config.keys.bindings);
    expect(keymap.direct.get("alt+4")).toEqual({ action: "switch_tab", index: 3 });
    expect(keymap.prefixed.get("4")).toBeUndefined();
    expect(keymap.direct.get(parseCombo("ctrl+shift+2")!)).toEqual({ action: "switch_workspace", index: 1 });
  });

  it("reads theme auto_switch settings", () => {
    const config = parseConfig({
      theme: {
        auto_switch: true,
        light_name: "one-light",
        custom: { accent: "#123456", light: { accent: "#abcdef" } },
      },
    });
    expect(config.theme).toMatchObject({
      auto_switch: true,
      light_name: "one-light",
      dark_name: "",
      custom: { accent: "#123456" },
      custom_light: { accent: "#abcdef" },
      custom_dark: {},
    });
  });

  it("parses the right-click passthrough modifier", () => {
    expect(parseConfig({ ui: { right_click_passthrough_modifier: "ctrl+alt" } })
      .ui.right_click_passthrough_modifier).toEqual({ ctrl: true, alt: true, super: false });
    expect(parseConfig({ ui: { right_click_passthrough_modifier: "off" } })
      .ui.right_click_passthrough_modifier).toBeNull();
    const diagnostics: string[] = [];
    expect(parseConfig({ ui: { right_click_passthrough_modifier: "shift" } }, diagnostics)
      .ui.right_click_passthrough_modifier).toBeNull();
    expect(diagnostics[0]).toMatch(/^ui\.right_click_passthrough_modifier:/);
  });

  it("loads config.toml and survives syntax errors", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-config-"));
    const file = path.join(directory, "config.toml");
    fs.writeFileSync(file, "[keys]\nprefix = \"ctrl+a\"\n[[keys.command]]\nkey = \"prefix+alt+g\"\ntype = \"popup\"\ncommand = \"lazygit\"\n");
    const loaded = loadConfig(file);
    expect(loaded.keymap.prefix).toBe("ctrl+a");
    expect(loaded.config.keys.commands[0]).toMatchObject({
      key: "prefix+alt+g",
      type: "popup",
      command: "lazygit",
      width: "80%",
    });
    fs.writeFileSync(file, "[keys\nprefix=");
    const broken = loadConfig(file);
    expect(broken.keymap.prefix).toBe("ctrl+b");
    expect(broken.diagnostics[0]).toMatch(/^config\.toml:/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

describe("directional layout", () => {
  //  p1 | p2
  //     |----
  //     | p3
  const layout: LayoutNode = {
    kind: "split",
    direction: "right",
    ratio: 0.5,
    first: { kind: "pane", paneId: "p1" },
    second: {
      kind: "split",
      direction: "down",
      ratio: 0.5,
      first: { kind: "pane", paneId: "p2" },
      second: { kind: "pane", paneId: "p3" },
    },
  };
  const area = { x: 0, y: 0, width: 100, height: 100 };
  const panes = layoutGeometry(layout, area);

  it("finds neighbours by edge, overlap and centre", () => {
    expect(paneInDirection(panes, "p1", "right")).toBe("p2");
    expect(paneInDirection(panes, "p3", "left")).toBe("p1");
    expect(paneInDirection(panes, "p2", "down")).toBe("p3");
    expect(paneInDirection(panes, "p3", "up")).toBe("p2");
    expect(paneInDirection(panes, "p1", "left")).toBeNull();
  });

  it("moves the nearest border in the requested direction", () => {
    const wider = resizeInDirection(layout, area, "p1", "right", 0.1);
    expect(wider.kind === "split" && wider.ratio).toBeCloseTo(0.6);
    // p2 has no border on its right; fall back to its left border.
    const moved = resizeInDirection(layout, area, "p2", "right", 0.1);
    expect(moved.kind === "split" && moved.ratio).toBeCloseTo(0.6);
    const taller = resizeInDirection(layout, area, "p3", "up", 0.1);
    expect(
      taller.kind === "split" && taller.second.kind === "split" &&
        taller.second.ratio,
    ).toBeCloseTo(0.4);
  });
});
