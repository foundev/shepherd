/** Key binding syntax and defaults, matching Shepherd's `[keys]` section:
 * `prefix+x` needs the prefix first, anything else is a direct chord in
 * terminal mode; `1..9` in a binding expands to the nine indexed keys. */

export const ACTIONS = [
  "help",
  "settings",
  "detach",
  "reload_config",
  "open_notification_target",
  "workspace_picker",
  "goto",
  "agent_desk",
  "new_workspace",
  "new_worktree",
  "open_worktree",
  "remove_worktree",
  "rename_workspace",
  "close_workspace",
  "previous_workspace",
  "next_workspace",
  "previous_agent",
  "next_agent",
  "focus_agent",
  "new_tab",
  "rename_tab",
  "previous_tab",
  "next_tab",
  "move_tab_previous",
  "move_tab_next",
  "switch_tab",
  "switch_workspace",
  "close_tab",
  "rename_pane",
  "edit_scrollback",
  "clear_pane",
  "copy_mode",
  "focus_pane_left",
  "focus_pane_down",
  "focus_pane_up",
  "focus_pane_right",
  "swap_pane_left",
  "swap_pane_down",
  "swap_pane_up",
  "swap_pane_right",
  "cycle_pane_next",
  "cycle_pane_previous",
  "last_pane",
  "split_vertical",
  "split_horizontal",
  "close_pane",
  "zoom",
  "resize_mode",
  "resize_pane_left",
  "resize_pane_down",
  "resize_pane_up",
  "resize_pane_right",
  "toggle_sidebar",
  // Shepherd additions.
  "plugin_actions",
  "refresh_machines",
  "remote_dashboard",
  "remote_panes",
  "remote_agents",
] as const;

export type Action = (typeof ACTIONS)[number];

export const INDEXED_ACTIONS: ReadonlySet<Action> = new Set([
  "switch_tab",
  "switch_workspace",
  "focus_agent",
]);

export const DEFAULT_BINDINGS: Record<Action, string[]> = {
  help: ["prefix+?"],
  settings: ["prefix+s"],
  detach: ["prefix+q"],
  reload_config: ["prefix+shift+r"],
  open_notification_target: ["prefix+o"],
  workspace_picker: ["prefix+w"],
  goto: ["prefix+g"],
  agent_desk: ["prefix+d"],
  new_workspace: ["prefix+shift+n"],
  new_worktree: ["prefix+shift+g"],
  open_worktree: [],
  remove_worktree: [],
  rename_workspace: ["prefix+shift+w"],
  close_workspace: ["prefix+shift+d"],
  previous_workspace: [],
  next_workspace: [],
  previous_agent: [],
  next_agent: [],
  focus_agent: [],
  new_tab: ["prefix+c"],
  rename_tab: ["prefix+shift+t"],
  previous_tab: ["prefix+p"],
  next_tab: ["prefix+n"],
  move_tab_previous: [],
  move_tab_next: [],
  switch_tab: ["prefix+1..9"],
  switch_workspace: [],
  close_tab: ["prefix+shift+x"],
  rename_pane: ["prefix+shift+p"],
  edit_scrollback: ["prefix+e"],
  clear_pane: [],
  copy_mode: ["prefix+["],
  focus_pane_left: ["prefix+h"],
  focus_pane_down: ["prefix+j"],
  focus_pane_up: ["prefix+k"],
  focus_pane_right: ["prefix+l"],
  swap_pane_left: ["prefix+shift+h"],
  swap_pane_down: ["prefix+shift+j"],
  swap_pane_up: ["prefix+shift+k"],
  swap_pane_right: ["prefix+shift+l"],
  cycle_pane_next: ["prefix+tab"],
  cycle_pane_previous: ["prefix+shift+tab"],
  last_pane: [],
  split_vertical: ["prefix+v"],
  split_horizontal: ["prefix+minus"],
  close_pane: ["prefix+x"],
  zoom: ["prefix+z"],
  resize_mode: ["prefix+r"],
  resize_pane_left: [],
  resize_pane_down: [],
  resize_pane_up: [],
  resize_pane_right: [],
  toggle_sidebar: ["prefix+b"],
  plugin_actions: ["prefix+a"],
  refresh_machines: ["prefix+shift+m"],
  remote_dashboard: ["prefix+shift+b"],
  remote_panes: ["prefix+shift+e"],
  remote_agents: ["prefix+shift+a"],
};

/** Legacy names accepted in config files. */
export const ACTION_ALIASES: Record<string, Action> = {
  fullscreen: "zoom",
};

export interface KeyLike {
  name: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  super?: boolean;
}

const NAMED_KEYS: Record<string, string> = {
  space: "space",
  " ": "space",
  enter: "enter",
  return: "enter",
  esc: "escape",
  escape: "escape",
  tab: "tab",
  backspace: "backspace",
  bs: "backspace",
  left: "left",
  right: "right",
  up: "up",
  down: "down",
  home: "home",
  end: "end",
  pageup: "pageup",
  pagedown: "pagedown",
  insert: "insert",
  delete: "delete",
  minus: "-",
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  quote: "'",
  double_quote: "\"",
  "double-quote": "\"",
  semicolon: ";",
  colon: ":",
  percent: "%",
  ampersand: "&",
  backtick: "`",
  plus: "+",
};

const MODIFIERS: Record<string, "ctrl" | "alt" | "shift" | "super"> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  meta: "alt",
  shift: "shift",
  cmd: "super",
  command: "super",
  super: "super",
};

/** Canonical string for a key, e.g. `ctrl+shift+tab` or `?`. Shift is
 * dropped for punctuation so `?` matches whatever the terminal sent. */
export function comboKey(key: KeyLike): string {
  const letter = /^[a-z]$/.test(key.name);
  const named = key.name.length > 1;
  const shift = key.shift && (letter || named);
  return [
    key.ctrl ? "ctrl" : "",
    key.alt ? "alt" : "",
    shift ? "shift" : "",
    key.super ? "super" : "",
    key.name,
  ].filter(Boolean).join("+");
}

/** Parses one key such as `ctrl+b`, `shift+tab`, `F12` or `P`. */
export function parseCombo(text: string): string | null {
  const parts = text.split("+").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    // A lone "+" is the plus key.
    if (text.trim() === "+") return comboKey(key("+"));
    return null;
  }
  const modifiers = { ctrl: false, alt: false, shift: false, super: false };
  let name: string | null = null;
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (modifier && !(name === null && parts.length === 1)) {
      modifiers[modifier] = true;
      continue;
    }
    if (name !== null) return null;
    name = part;
  }
  if (name === null) return null;
  const lower = name.toLowerCase();
  let resolved = NAMED_KEYS[lower];
  if (!resolved) {
    if ([...name].length === 1) {
      if (/^[A-Z]$/.test(name)) modifiers.shift = true;
      resolved = name.length === 1 && /[A-Za-z]/.test(name) ? lower : name;
    } else if (/^f([1-9]|1[0-2])$/.test(lower)) {
      resolved = lower;
    } else {
      return null;
    }
  }
  return comboKey({ name: resolved, ...modifiers });
}

function key(name: string): KeyLike {
  return { name, ctrl: false, alt: false, shift: false };
}

export interface ParsedBinding {
  prefix: boolean;
  combo: string;
  /** For indexed bindings, 0..8. */
  index?: number;
}

/** Parses a binding string. Indexed bindings (`prefix+1..9`) expand to nine
 * bindings carrying their index. */
export function parseBinding(text: string): ParsedBinding[] | null {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let rest = trimmed;
  let prefix = false;
  if (/^prefix\+/i.test(rest)) {
    prefix = true;
    rest = rest.slice("prefix+".length);
  }
  if (rest.includes("1..9")) {
    const template = rest.replace("1..9", "__INDEX__");
    const bindings: ParsedBinding[] = [];
    for (let index = 1; index <= 9; index += 1) {
      const combo = parseCombo(template.replace("__INDEX__", String(index)));
      if (!combo) return null;
      bindings.push({ prefix, combo, index: index - 1 });
    }
    return bindings;
  }
  const combo = parseCombo(rest);
  return combo ? [{ prefix, combo }] : null;
}

export interface Keymap {
  prefix: string;
  /** Combo → action (and index) after the prefix. */
  prefixed: Map<string, { action: Action; index?: number }>;
  /** Combo → action in terminal mode, without the prefix. */
  direct: Map<string, { action: Action; index?: number }>;
  /** Display strings for help, per action. */
  labels: Map<Action, string[]>;
  /** Custom command bindings: combo → index into config commands. */
  commandsPrefixed: Map<string, number>;
  commandsDirect: Map<string, number>;
}

/** Adds `[[keys.command]]` bindings; they win over built-in actions. */
export function bindCommands(
  keymap: Keymap,
  keys: string[],
  diagnostics: string[] = [],
): Keymap {
  keys.forEach((text, index) => {
    const parsed = parseBinding(text);
    if (!parsed || parsed.length !== 1 || parsed[0]?.index !== undefined) {
      diagnostics.push(`keys.command[${index}]: invalid key "${text}"`);
      return;
    }
    const [binding] = parsed;
    if (!binding) return;
    (binding.prefix ? keymap.commandsPrefixed : keymap.commandsDirect)
      .set(binding.combo, index);
  });
  return keymap;
}

export function buildKeymap(
  prefixText: string,
  bindings: Partial<Record<Action, string[]>>,
  diagnostics: string[] = [],
): Keymap {
  const prefix = parseCombo(prefixText) ?? (() => {
    diagnostics.push(`keys.prefix: invalid key "${prefixText}", using ctrl+b`);
    return "ctrl+b";
  })();
  const keymap: Keymap = {
    prefix,
    prefixed: new Map(),
    direct: new Map(),
    labels: new Map(),
    commandsPrefixed: new Map(),
    commandsDirect: new Map(),
  };
  for (const action of ACTIONS) {
    const texts = bindings[action] ?? DEFAULT_BINDINGS[action];
    const labels: string[] = [];
    for (const text of texts) {
      const parsed = parseBinding(text);
      if (!parsed) {
        diagnostics.push(`keys.${action}: invalid binding "${text}"`);
        continue;
      }
      if (parsed.length === 0) continue;
      if (parsed.some((entry) => entry.index !== undefined) &&
        !INDEXED_ACTIONS.has(action)) {
        diagnostics.push(`keys.${action}: 1..9 is only valid for indexed actions`);
        continue;
      }
      labels.push(text);
      for (const entry of parsed) {
        const target = entry.prefix ? keymap.prefixed : keymap.direct;
        target.set(entry.combo, { action, index: entry.index });
      }
    }
    keymap.labels.set(action, labels);
  }
  return keymap;
}
