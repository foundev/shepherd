import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import {
  ACTION_ALIASES,
  ACTIONS,
  bindCommands,
  buildKeymap,
  parseBinding,
  type Action,
  type Keymap,
} from "./keybinds.js";
import { defaultSidebarConfig, parseSidebarConfig, type SidebarConfig } from "./sidebar.js";

export type ToastPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "top-center"
  | "bottom-center";

const TOAST_POSITIONS: ToastPosition[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "top-center",
  "bottom-center",
];

/** An entry at the right of the tab bar (Shepherd's `ui.tab_bar_right`). */
export type TabBarStatusItem =
  | { type: "zoom" }
  | { type: "hostname" }
  | { type: "datetime"; format: string }
  | { type: "text"; text: string }
  | { type: "command"; command: string; interval_seconds: number; timeout_seconds: number };

export interface CustomCommand {
  key: string;
  type: "popup" | "pane" | "shell" | "plugin_action";
  command: string;
  description: string;
  width: string;
  height: string;
}

export interface ShepherdConfig {
  keys: {
    prefix: string;
    bindings: Partial<Record<Action, string[]>>;
    commands: CustomCommand[];
    navigate: {
      workspace_up: string;
      workspace_down: string;
      pane_left: string;
      pane_down: string;
      pane_up: string;
      pane_right: string;
    };
  };
  theme: {
    name: string;
    custom: Record<string, string>;
    /** Follow the host terminal's light/dark appearance. */
    auto_switch: boolean;
    dark_name: string;
    light_name: string;
    /** `[theme.custom.light]` / `[theme.custom.dark]` overrides. */
    custom_light: Record<string, string>;
    custom_dark: Record<string, string>;
  };
  terminal: {
    default_shell: string;
    shell_mode: "auto" | "login" | "non_login";
    new_cwd: string;
  };
  ui: {
    mouse_capture: boolean;
    copy_on_select: boolean;
    mouse_scroll_lines: number;
    confirm_close: boolean;
    prompt_new_tab_name: boolean;
    prompt_new_workspace_name: boolean;
    window_title: string;
    status_indicators: "dots" | "symbols";
    hide_tab_bar_when_single_tab: boolean;
    tab_bar_position: "top" | "bottom";
    tab_bar_right: TabBarStatusItem[];
    tab_bar_right_separator: string;
    sidebar_width: number;
    sidebar_min_width: number;
    sidebar_max_width: number;
    sidebar_start_collapsed: boolean;
    sidebar_collapsed_mode: "compact" | "hidden";
    mobile_width_threshold: number;
    pane_borders: "auto" | "always" | "off";
    pane_outer_borders: boolean;
    pane_scrollbars: boolean;
    pane_gaps: boolean;
    show_agent_labels_on_pane_borders: boolean;
    /** Modifiers that send right-clicks to the pane app; null = off. */
    right_click_passthrough_modifier: { ctrl: boolean; alt: boolean; super: boolean } | null;
    sidebar: SidebarConfig;
    agent_panel_sort: "spaces" | "status";
    accent: string;
    toast: {
      delivery: "off" | "shepherd" | "terminal" | "system";
      delay_seconds: number;
      position: ToastPosition;
      clipboard_enabled: boolean;
      clipboard_position: ToastPosition;
    };
    sound: {
      enabled: boolean;
      path: string;
      done_path: string;
      request_path: string;
      agents: Record<string, "default" | "on" | "off">;
    };
  };
  advanced: {
    scrollback_limit_bytes: number;
  };
  worktrees: {
    directory: string;
  };
  experimental: {
    /** Save pane screen history to session-history.json. */
    pane_history: boolean;
  };
  session: {
    resume_agents_on_restore: boolean;
    startup_per_agent_delay_ms: number;
  };
  remote: {
    /** Run ssh through a generated config (the user's config Included,
     * plus keepalive fallbacks) and a private ControlMaster socket. */
    manage_ssh_config: boolean;
  };
}

export const DEFAULT_CONFIG: ShepherdConfig = {
  keys: {
    prefix: "ctrl+b",
    bindings: {},
    commands: [],
    navigate: {
      workspace_up: "up",
      workspace_down: "down",
      pane_left: "h",
      pane_down: "j",
      pane_up: "k",
      pane_right: "l",
    },
  },
  theme: {
    name: "shepherd",
    custom: {},
    auto_switch: false,
    dark_name: "",
    light_name: "",
    custom_light: {},
    custom_dark: {},
  },
  terminal: { default_shell: "", shell_mode: "auto", new_cwd: "follow" },
  ui: {
    mouse_capture: true,
    copy_on_select: true,
    mouse_scroll_lines: 3,
    confirm_close: true,
    prompt_new_tab_name: true,
    prompt_new_workspace_name: false,
    window_title: "{hostname}: {workspace}",
    status_indicators: "symbols",
    hide_tab_bar_when_single_tab: false,
    tab_bar_position: "top",
    tab_bar_right: [],
    tab_bar_right_separator: " ",
    sidebar_width: 26,
    sidebar_min_width: 18,
    sidebar_max_width: 36,
    sidebar_start_collapsed: false,
    sidebar_collapsed_mode: "compact",
    mobile_width_threshold: 64,
    pane_borders: "auto",
    pane_outer_borders: true,
    pane_scrollbars: true,
    pane_gaps: true,
    show_agent_labels_on_pane_borders: false,
    right_click_passthrough_modifier: null,
    sidebar: defaultSidebarConfig(),
    agent_panel_sort: "status",
    accent: "",
    // Enable Shepherd toasts by default.
    // yet, so in-app toasts are on by default.
    toast: {
      delivery: "shepherd",
      delay_seconds: 1,
      position: "bottom-right",
      clipboard_enabled: true,
      clipboard_position: "bottom-center",
    },
    sound: {
      enabled: true,
      path: "",
      done_path: "",
      request_path: "",
      agents: { droid: "off" },
    },
  },
  advanced: { scrollback_limit_bytes: 10_000_000 },
  worktrees: { directory: "~/.shepherd/worktrees" },
  experimental: { pane_history: false },
  session: { resume_agents_on_restore: true, startup_per_agent_delay_ms: 100 },
  remote: { manage_ssh_config: true },
};

export interface LoadedConfig {
  config: ShepherdConfig;
  keymap: Keymap;
  path: string;
  diagnostics: string[];
}

/** Defaults with no file read, for tests and embedded use. */
export function defaultLoadedConfig(): LoadedConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  return {
    config,
    keymap: bindCommands(buildKeymap(config.keys.prefix, config.keys.bindings), []),
    path: "",
    diagnostics: [],
  };
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SHEPHERD_CONFIG_PATH) return env.SHEPHERD_CONFIG_PATH;
  if (env.SHEPHERD_CONFIG_HOME) {
    return path.join(env.SHEPHERD_CONFIG_HOME, "config.toml");
  }
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "shepherd", "config.toml");
}

/** Loads config.toml. Invalid values fall back to their defaults and are
 * reported in `diagnostics`, as in Shepherd. A missing file is not an error. */
export function loadConfig(file = configPath()): LoadedConfig {
  const diagnostics: string[] = [];
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      raw = parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch (error) {
      diagnostics.push(
        `config.toml: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const config = parseConfig(raw, diagnostics);
  const keymap = bindCommands(
    buildKeymap(config.keys.prefix, config.keys.bindings, diagnostics),
    config.keys.commands.map((command) => command.key),
    diagnostics,
  );
  return { config, keymap, path: file, diagnostics };
}

/** Shepherd's right-click passthrough modifier syntax; undefined if invalid. */
function parsePassthroughModifier(
  value: string,
): ShepherdConfig["ui"]["right_click_passthrough_modifier"] | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || ["off", "none", "disabled"].includes(trimmed)) return null;
  const modifiers = { ctrl: false, alt: false, super: false };
  for (const token of trimmed.split("+").map((part) => part.trim())) {
    if (token === "ctrl" || token === "control") modifiers.ctrl = true;
    else if (token === "alt" || token === "option" || token === "meta") modifiers.alt = true;
    else if (["cmd", "command", "super", "hyper"].includes(token)) modifiers.super = true;
    else return undefined;
  }
  return modifiers;
}

export function parseConfig(
  raw: Record<string, unknown>,
  diagnostics: string[] = [],
): ShepherdConfig {
  const config: ShepherdConfig = structuredClone(DEFAULT_CONFIG);
  const reader = new Reader(diagnostics);

  const keys = reader.table(raw, "keys");
  config.keys.prefix = reader.string(keys, "prefix", "keys", config.keys.prefix);
  for (const [name, value] of Object.entries(keys)) {
    if (["prefix", "command", "indexed", "navigate"].includes(name)) continue;
    if (name.startsWith("navigate_")) continue;
    const action = (ACTION_ALIASES[name] ?? name) as Action;
    if (!ACTIONS.includes(action)) {
      diagnostics.push(`keys.${name}: unknown action`);
      continue;
    }
    if (typeof value === "string") config.keys.bindings[action] = [value];
    else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      config.keys.bindings[action] = value as string[];
    } else {
      diagnostics.push(`keys.${name}: expected a string or array of strings`);
    }
  }
  for (const direction of Object.keys(config.keys.navigate) as Array<
    keyof ShepherdConfig["keys"]["navigate"]
  >) {
    config.keys.navigate[direction] = reader.string(
      keys,
      `navigate_${direction}`,
      "keys",
      config.keys.navigate[direction],
    );
  }
  // Legacy [keys.indexed]: a modifier combo for direct 1..9 shortcuts. It
  // replaces the default binding of its action and adds to a user one.
  const indexed = reader.table(keys, "indexed");
  const indexedActions = { tabs: "switch_tab", workspaces: "switch_workspace", agents: "focus_agent" } as const;
  for (const [name, action] of Object.entries(indexedActions)) {
    const modifiers = reader.string(indexed, name, "keys.indexed", "").trim();
    if (!modifiers) continue;
    const binding = `${modifiers}+1..9`;
    const valid = /^(?:(?:ctrl|alt|shift|cmd|super|meta|hyper)\+)*(?:ctrl|alt|shift|cmd|super|meta|hyper)$/i
      .test(modifiers) && parseBinding(binding);
    if (!valid) {
      diagnostics.push(`keys.indexed.${name}: invalid indexed keybinding "${modifiers}"; disabling binding`);
      continue;
    }
    config.keys.bindings[action] = [...(config.keys.bindings[action] ?? []), binding];
  }
  const commands = keys.command;
  if (Array.isArray(commands)) {
    commands.forEach((entry, index) => {
      if (!entry || typeof entry !== "object") return;
      const table = entry as Record<string, unknown>;
      const type = table.type ?? "popup";
      if (
        typeof table.key !== "string" ||
        typeof table.command !== "string" ||
        !["popup", "pane", "shell", "plugin_action"].includes(String(type))
      ) {
        diagnostics.push(`keys.command[${index}]: needs key, command and a valid type`);
        return;
      }
      config.keys.commands.push({
        key: table.key,
        type: type as CustomCommand["type"],
        command: table.command,
        description: typeof table.description === "string" ? table.description : "",
        width: String(table.width ?? "80%"),
        height: String(table.height ?? "80%"),
      });
    });
  }

  const theme = reader.table(raw, "theme");
  config.theme.name = reader.string(theme, "name", "theme", config.theme.name);
  config.theme.auto_switch = reader.boolean(theme, "auto_switch", "theme", false);
  config.theme.dark_name = reader.string(theme, "dark_name", "theme", "");
  config.theme.light_name = reader.string(theme, "light_name", "theme", "");
  const custom = reader.table(theme, "custom");
  for (const mode of ["light", "dark"] as const) {
    for (const [name, value] of Object.entries(reader.table(custom, mode))) {
      if (typeof value === "string") config.theme[`custom_${mode}`][name] = value;
    }
  }
  for (const [name, value] of Object.entries(custom)) {
    if (typeof value === "string") config.theme.custom[name] = value;
  }

  const terminal = reader.table(raw, "terminal");
  config.terminal.default_shell = reader.string(
    terminal,
    "default_shell",
    "terminal",
    config.terminal.default_shell,
  );
  config.terminal.shell_mode = reader.oneOf(
    terminal,
    "shell_mode",
    "terminal",
    ["auto", "login", "non_login"],
    config.terminal.shell_mode,
  );
  config.terminal.new_cwd = reader.string(
    terminal,
    "new_cwd",
    "terminal",
    config.terminal.new_cwd,
  );

  const ui = reader.table(raw, "ui");
  const booleans = [
    "mouse_capture",
    "copy_on_select",
    "confirm_close",
    "prompt_new_tab_name",
    "prompt_new_workspace_name",
    "hide_tab_bar_when_single_tab",
    "sidebar_start_collapsed",
    "pane_outer_borders",
    "pane_scrollbars",
    "pane_gaps",
    "show_agent_labels_on_pane_borders",
  ] as const;
  for (const name of booleans) {
    config.ui[name] = reader.boolean(ui, name, "ui", config.ui[name]);
  }
  config.ui.sidebar = parseSidebarConfig(ui.sidebar, diagnostics);
  const passthrough = ui.right_click_passthrough_modifier;
  if (passthrough !== undefined) {
    const parsed = typeof passthrough === "string"
      ? parsePassthroughModifier(passthrough)
      : undefined;
    if (parsed === undefined) {
      diagnostics.push(
        "ui.right_click_passthrough_modifier: must be empty, off, none, disabled, ctrl/control, alt/option, cmd/command/super, meta, hyper, or a + separated combination without shift",
      );
    } else {
      config.ui.right_click_passthrough_modifier = parsed;
    }
  }
  config.ui.mouse_scroll_lines = reader.integer(
    ui,
    "mouse_scroll_lines",
    "ui",
    config.ui.mouse_scroll_lines,
    1,
    100,
  );
  config.ui.sidebar_min_width = reader.integer(
    ui,
    "sidebar_min_width",
    "ui",
    config.ui.sidebar_min_width,
    4,
    120,
  );
  config.ui.sidebar_max_width = reader.integer(
    ui,
    "sidebar_max_width",
    "ui",
    config.ui.sidebar_max_width,
    config.ui.sidebar_min_width,
    120,
  );
  config.ui.sidebar_width = Math.min(
    config.ui.sidebar_max_width,
    Math.max(
      config.ui.sidebar_min_width,
      reader.integer(ui, "sidebar_width", "ui", config.ui.sidebar_width, 4, 120),
    ),
  );
  config.ui.sidebar_collapsed_mode = reader.oneOf(
    ui,
    "sidebar_collapsed_mode",
    "ui",
    ["compact", "hidden"],
    config.ui.sidebar_collapsed_mode,
  );
  config.ui.mobile_width_threshold = reader.integer(
    ui,
    "mobile_width_threshold",
    "ui",
    config.ui.mobile_width_threshold,
    0,
    1000,
  );
  // Legacy booleans: true = "auto", false = "off".
  const paneBorders = ui.pane_borders;
  if (typeof paneBorders === "boolean") {
    config.ui.pane_borders = paneBorders ? "auto" : "off";
  } else {
    config.ui.pane_borders = reader.oneOf(
      ui,
      "pane_borders",
      "ui",
      ["auto", "always", "off"],
      config.ui.pane_borders,
    );
  }
  // Legacy aliases: "workspaces" for "spaces", "priority" for "status".
  const sort = ui.agent_panel_sort === "workspaces"
    ? "spaces"
    : ui.agent_panel_sort === "priority"
      ? "status"
      : undefined;
  config.ui.agent_panel_sort = sort ?? reader.oneOf(
    ui,
    "agent_panel_sort",
    "ui",
    ["spaces", "status"],
    config.ui.agent_panel_sort,
  );
  config.ui.window_title = reader.string(ui, "window_title", "ui", config.ui.window_title);
  config.ui.accent = reader.string(ui, "accent", "ui", config.ui.accent);
  config.ui.status_indicators = reader.oneOf(
    ui,
    "status_indicators",
    "ui",
    ["dots", "symbols"],
    config.ui.status_indicators,
  );
  config.ui.tab_bar_position = reader.oneOf(
    ui,
    "tab_bar_position",
    "ui",
    ["top", "bottom"],
    config.ui.tab_bar_position,
  );

  const right = ui.tab_bar_right;
  if (Array.isArray(right)) {
    right.forEach((entry, index) => {
      const table = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
      const where = `ui.tab_bar_right[${index}]`;
      switch (table.type) {
        case "zoom":
        case "hostname":
          config.ui.tab_bar_right.push({ type: table.type });
          return;
        case "datetime":
          config.ui.tab_bar_right.push({
            type: "datetime",
            format: typeof table.format === "string" ? table.format : "%H:%M",
          });
          return;
        case "text":
          if (typeof table.text === "string") {
            config.ui.tab_bar_right.push({ type: "text", text: table.text });
            return;
          }
          break;
        case "command": {
          const interval = Number(table.interval_seconds ?? 60);
          const timeout = Number(table.timeout_seconds ?? 5);
          if (
            typeof table.command === "string" &&
            Number.isInteger(interval) && interval >= 1 && interval <= 31_536_000 &&
            Number.isInteger(timeout) && timeout >= 1 && timeout <= 3_600
          ) {
            config.ui.tab_bar_right.push({
              type: "command",
              command: table.command,
              interval_seconds: interval,
              timeout_seconds: timeout,
            });
            return;
          }
          break;
        }
      }
      diagnostics.push(`${where}: invalid status entry`);
    });
  } else if (right !== undefined) {
    diagnostics.push("ui.tab_bar_right: expected an array");
  }
  config.ui.tab_bar_right_separator = reader.string(
    ui,
    "tab_bar_right_separator",
    "ui",
    config.ui.tab_bar_right_separator,
  );

  const toast = reader.table(ui, "toast");
  config.ui.toast.delivery = reader.oneOf(
    toast,
    "delivery",
    "ui.toast",
    ["off", "shepherd", "terminal", "system"],
    config.ui.toast.delivery,
  );
  config.ui.toast.delay_seconds = reader.integer(
    toast,
    "delay_seconds",
    "ui.toast",
    config.ui.toast.delay_seconds,
    0,
    3600,
  );
  config.ui.toast.position = reader.oneOf(
    reader.table(toast, "shepherd"),
    "position",
    "ui.toast.shepherd",
    TOAST_POSITIONS,
    config.ui.toast.position,
  );
  const clipboardToast = reader.table(toast, "clipboard");
  config.ui.toast.clipboard_enabled = reader.boolean(
    clipboardToast,
    "enabled",
    "ui.toast.clipboard",
    config.ui.toast.clipboard_enabled,
  );
  config.ui.toast.clipboard_position = reader.oneOf(
    clipboardToast,
    "position",
    "ui.toast.clipboard",
    TOAST_POSITIONS,
    config.ui.toast.clipboard_position,
  );

  const sound = reader.table(ui, "sound");
  config.ui.sound.enabled = reader.boolean(sound, "enabled", "ui.sound", config.ui.sound.enabled);
  for (const name of ["path", "done_path", "request_path"] as const) {
    config.ui.sound[name] = reader.string(sound, name, "ui.sound", config.ui.sound[name]);
  }
  for (const [agent, value] of Object.entries(reader.table(sound, "agents"))) {
    if (value === "default" || value === "on" || value === "off") {
      config.ui.sound.agents[agent] = value;
    } else {
      diagnostics.push(`ui.sound.agents.${agent}: expected default, on or off`);
    }
  }

  const sessionTable = reader.table(raw, "session");
  const experimental = reader.table(raw, "experimental");
  config.experimental.pane_history = reader.boolean(
    experimental,
    "pane_history",
    "experimental",
    false,
  );
  config.session.resume_agents_on_restore = reader.boolean(
    sessionTable,
    "resume_agents_on_restore",
    "session",
    config.session.resume_agents_on_restore,
  );
  config.session.startup_per_agent_delay_ms = reader.integer(
    sessionTable,
    "startup_per_agent_delay_ms",
    "session",
    config.session.startup_per_agent_delay_ms,
    0,
    60_000,
  );

  config.worktrees.directory = reader.string(
    reader.table(raw, "worktrees"),
    "directory",
    "worktrees",
    config.worktrees.directory,
  );

  config.remote.manage_ssh_config = reader.boolean(
    reader.table(raw, "remote"),
    "manage_ssh_config",
    "remote",
    config.remote.manage_ssh_config,
  );

  const advanced = reader.table(raw, "advanced");
  config.advanced.scrollback_limit_bytes = reader.integer(
    advanced,
    "scrollback_limit_bytes",
    "advanced",
    config.advanced.scrollback_limit_bytes,
    100_000,
    1_000_000_000,
  );
  return config;
}

class Reader {
  constructor(private readonly diagnostics: string[]) {}

  table(raw: Record<string, unknown>, name: string): Record<string, unknown> {
    const value = raw[name];
    if (value === undefined) return {};
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    this.diagnostics.push(`${name}: expected a table`);
    return {};
  }

  string(
    table: Record<string, unknown>,
    name: string,
    section: string,
    fallback: string,
  ): string {
    const value = table[name];
    if (value === undefined) return fallback;
    if (typeof value === "string") return value;
    this.diagnostics.push(`${section}.${name}: expected a string`);
    return fallback;
  }

  boolean(
    table: Record<string, unknown>,
    name: string,
    section: string,
    fallback: boolean,
  ): boolean {
    const value = table[name];
    if (value === undefined) return fallback;
    if (typeof value === "boolean") return value;
    this.diagnostics.push(`${section}.${name}: expected true or false`);
    return fallback;
  }

  integer(
    table: Record<string, unknown>,
    name: string,
    section: string,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    const value = table[name];
    if (value === undefined) return fallback;
    const number = typeof value === "bigint" ? Number(value) : value;
    if (
      typeof number === "number" &&
      Number.isInteger(number) &&
      number >= minimum &&
      number <= maximum
    ) {
      return number;
    }
    this.diagnostics.push(
      `${section}.${name}: expected an integer from ${minimum} to ${maximum}`,
    );
    return fallback;
  }

  oneOf<T extends string>(
    table: Record<string, unknown>,
    name: string,
    section: string,
    options: readonly T[],
    fallback: T,
  ): T {
    const value = table[name];
    if (value === undefined) return fallback;
    if (typeof value === "string" && (options as readonly string[]).includes(value)) {
      return value as T;
    }
    this.diagnostics.push(`${section}.${name}: expected one of ${options.join(", ")}`);
    return fallback;
  }
}
