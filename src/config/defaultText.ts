/** The annotated default config printed by `shepherd config template`,
 * generated from the settings Shepherd reads in
 * src/config/model.ts. Every value is commented out and equals the built-in
 * default, so printing it into config.toml changes nothing until edited. */
import { DEFAULT_CONFIG } from "./model.js";
import { ACTIONS, DEFAULT_BINDINGS } from "./keybinds.js";

const d = DEFAULT_CONFIG;

function toml(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  return String(value);
}

function keyLines(): string {
  return ACTIONS.map((action) => {
    const bindings = DEFAULT_BINDINGS[action];
    const value = bindings.length === 1 ? toml(bindings[0]) : toml(bindings);
    const note = bindings.length === 0 ? "  # optional, unset by default" : "";
    return `# ${action} = ${bindings.length === 0 ? '""' : value}${note}`;
  }).join("\n");
}

export const DEFAULT_CONFIG_TEXT = `# shepherd configuration
# Place this file at ~/.config/shepherd/config.toml
# (SHEPHERD_CONFIG_PATH or SHEPHERD_CONFIG_HOME override the location).

[theme]
# Built-in themes: shepherd, shepherd-day, aurora, ember, midnight,
#                  orchid, glacier, parchment, terminal
# name = ${toml(d.theme.name)}

# Override individual color tokens on top of the base theme.
# Accepts: hex (#rrggbb), named colors, rgb(r,g,b), or panel_bg = "reset"
# [theme.custom]
# sidebar_bg = "#0b111b"
# accent = "#61d6c0"

[terminal]
# Executable used for new interactive panes.
# Empty means $SHELL, then /bin/sh.
# default_shell = ${toml(d.terminal.default_shell)}

# Startup mode for new interactive pane shells: "auto", "login", or "non_login".
# "auto" uses login shells on macOS and keeps the current behavior elsewhere.
# shell_mode = ${toml(d.terminal.shell_mode)}

# CWD policy for new panes, tabs, and workspaces when no explicit --cwd is provided.
# Use "follow" to inherit the source pane/workspace, "home" for $HOME,
# "current" for Shepherd's process directory, or a fixed path such as "~/Projects".
# new_cwd = ${toml(d.terminal.new_cwd)}

[keys]
# Prefix key to enter prefix mode.
# Action bindings use explicit syntax: "prefix+n" requires the prefix;
# "ctrl+alt+n" is a direct terminal-mode shortcut. "1..9" expands to nine keys.
# Accepted key syntax: plain keys, ctrl/shift/alt/cmd/super modifiers, and
# special keys like enter/tab/esc/left/right/up/down. Named punctuation such
# as minus, comma, plus, and backtick is also accepted.
# An action may take a single binding or an array of bindings.
# prefix = ${toml(d.keys.prefix)}

${keyLines()}

# Navigate-mode movement. These local shortcuts win while navigate mode is open.
# navigate_workspace_up = ${toml(d.keys.navigate.workspace_up)}
# navigate_workspace_down = ${toml(d.keys.navigate.workspace_down)}
# navigate_pane_left = ${toml(d.keys.navigate.pane_left)}
# navigate_pane_down = ${toml(d.keys.navigate.pane_down)}
# navigate_pane_up = ${toml(d.keys.navigate.pane_up)}
# navigate_pane_right = ${toml(d.keys.navigate.pane_right)}

# Custom commands use the same binding syntax.
# type = "shell" runs detached in the background.
# type = "pane" opens a temporary pane and closes it when the command exits.
# type = "popup" opens a modal terminal without changing the tab layout.
# type = "plugin_action" invokes a plugin action by id.
# Popup width and height accept terminal cells or percentages such as "80%".
# [[keys.command]]
# key = "prefix+alt+g"
# type = "popup"
# command = "lazygit"
# width = "80%"
# height = "80%"

# [worktrees]
# directory = ${toml(d.worktrees.directory)}

[ui]
# Sidebar width (auto-scaled based on workspace names, this sets the default)
# sidebar_width = ${d.ui.sidebar_width}

# Minimum and maximum sidebar width when expanded (columns)
# sidebar_min_width = ${d.ui.sidebar_min_width}
# sidebar_max_width = ${d.ui.sidebar_max_width}

# Start with the sidebar collapsed.
# sidebar_start_collapsed = ${d.ui.sidebar_start_collapsed}

# Collapsed sidebar presentation: "compact" keeps the narrow status rail, "hidden" uses zero width.
# sidebar_collapsed_mode = ${toml(d.ui.sidebar_collapsed_mode)}

# Terminal width at or below which Shepherd uses the single-column layout.
# mobile_width_threshold = ${d.ui.mobile_width_threshold}

# Capture mouse input for Shepherd's mouse UI.
# Set false to let the terminal handle normal clicks.
# mouse_capture = ${d.ui.mouse_capture}

# Automatically copy text selected with the mouse.
# copy_on_select = ${d.ui.copy_on_select}

# Pane scrollback lines to scroll per mouse wheel notch.
# mouse_scroll_lines = ${d.ui.mouse_scroll_lines}

# Ask for confirmation before closing a workspace
# confirm_close = ${d.ui.confirm_close}

# Ask for a tab name before creating a new tab.
# prompt_new_tab_name = ${d.ui.prompt_new_tab_name}

# Ask for a workspace name before interactive creation.
# prompt_new_workspace_name = ${d.ui.prompt_new_workspace_name}

# Draw borders around split panes: "auto", "always", or "off".
# Legacy booleans still parse: true = "auto", false = "off".
# pane_borders = ${toml(d.ui.pane_borders)}

# Draw borders along the outside edge of the pane area.
# pane_outer_borders = ${d.ui.pane_outer_borders}

# Draw scrollbars beside terminal panes.
# pane_scrollbars = ${d.ui.pane_scrollbars}

# Keep split panes visually separated instead of sharing divider borders.
# pane_gaps = ${d.ui.pane_gaps}

# Show detected agent labels in split pane borders when no manual pane name is set.
# show_agent_labels_on_pane_borders = ${d.ui.show_agent_labels_on_pane_borders}

# Hide the tab row when a workspace has exactly one tab.
# hide_tab_bar_when_single_tab = ${d.ui.hide_tab_bar_when_single_tab}

# Tab row placement: "top" or "bottom".
# tab_bar_position = ${toml(d.ui.tab_bar_position)}

# Ordered status entries at the right edge of the tab bar.
# Supported types: zoom, hostname, datetime (format), text (text), and
# command (command, interval_seconds, timeout_seconds).
# tab_bar_right = []
# tab_bar_right_separator = ${toml(d.ui.tab_bar_right_separator)}

# Title Shepherd writes to the terminal it runs in. Tokens are {hostname},
# {workspace}, {tab}, {pane}, and {terminal_title}. Set to "" to leave it alone.
# window_title = ${toml(d.ui.window_title)}

# Agent panel ordering: "spaces" (grouped by space) or "priority" (attention queue).
# "workspaces" is accepted as an alias for "spaces".
# agent_panel_sort = ${toml(d.ui.agent_panel_sort)}

# Agent status indicators: "dots" or "symbols".
# status_indicators = ${toml(d.ui.status_indicators)}

# Accent color for highlights, borders, and navigation UI. Empty uses the theme's.
# accent = ${toml(d.ui.accent)}

# Background notification popup delivery
[ui.toast]
# off = disable pop-up notifications
# shepherd = show in-app toasts
# terminal = ask the outer terminal to show a desktop notification
# system = ask the OS notification service directly
# delivery = ${toml(d.ui.toast.delivery)}
# delay_seconds = ${d.ui.toast.delay_seconds}

[ui.toast.shepherd]
# top-left, top-right, bottom-left, bottom-right, top-center, bottom-center
# position = ${toml(d.ui.toast.position)}

[ui.toast.clipboard]
# enabled = ${d.ui.toast.clipboard_enabled}
# position = ${toml(d.ui.toast.clipboard_position)}

# Play sounds when agents change state in background workspaces
[ui.sound]
# enabled = ${d.ui.sound.enabled}
# Optional custom sound files. Relative paths are resolved from this config file's directory.
# path = "sounds/notification.mp3"   # one file for all sound notifications
# done_path = "sounds/done.mp3"      # overrides only finished notifications
# request_path = "sounds/request.mp3" # overrides only needs-attention notifications

# Per-agent overrides: default | on | off
# By default, droid is muted.
# [ui.sound.agents]
# droid = "off"

[session]
# Resume supported AI-agent panes into their native conversation sessions after
# a daemon restart. Requires integrations that report session ids
# (see \`shepherd integration install claude\`).
# resume_agents_on_restore = ${d.session.resume_agents_on_restore}
# Milliseconds between automatic agent restores; 0 starts them without spacing.
# startup_per_agent_delay_ms = ${d.session.startup_per_agent_delay_ms}

[remote]
# Run ssh for --remote and saved machines through a generated
# config that Includes your ~/.ssh/config and adds keepalive fallbacks, and
# reuse connections through a private ControlMaster socket. false uses
# plain ssh.
# manage_ssh_config = ${d.remote.manage_ssh_config}

[advanced]
# Maximum scrollback buffer size in bytes retained per pane terminal.
# scrollback_limit_bytes = ${d.advanced.scrollback_limit_bytes}
`;
