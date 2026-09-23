import { Box, Text } from "ink";
import { theme } from "./theme.js";
import type { Action, Keymap } from "../config/keybinds.js";
import type { ToastPosition } from "../config/model.js";

export interface ToastEntry {
  id: string;
  title: string;
  context: string;
  tone: "attention" | "done" | "clipboard";
  position: ToastPosition;
}

/** Floating toasts in their configured corner; the newest is last. */
export function ToastStack({
  toasts,
  columns,
  rows,
}: {
  toasts: ToastEntry[];
  columns: number;
  rows: number;
}) {
  const width = Math.min(44, Math.max(20, columns - 4));
  return (
    <>
      {toasts.map((toast, index) => {
        const height = toast.context ? 4 : 3;
        const fromBottom = toasts.length - index;
        const top = toast.position.startsWith("top")
          ? 1 + index * height
          : Math.max(0, rows - 1 - fromBottom * height);
        const left = toast.position.endsWith("left")
          ? 1
          : toast.position.endsWith("center")
            ? Math.max(0, Math.floor((columns - width) / 2))
            : Math.max(0, columns - width - 1);
        const color = toast.tone === "attention"
          ? theme.danger
          : toast.tone === "clipboard"
            ? theme.success
            : theme.cyan;
        return (
          <Box
            key={toast.id}
            position="absolute"
            marginLeft={left}
            marginTop={top}
            width={width}
            height={height}
            borderStyle="round"
            borderColor={color}
            backgroundColor={theme.surfaceRaised}
            paddingX={1}
            flexDirection="column"
          >
            <Text wrap="truncate-end">
              <Text color={color}>● </Text>
              <Text color={theme.text} bold>{toast.title}</Text>
            </Text>
            {toast.context ? (
              <Text color={theme.muted} wrap="truncate-end">{toast.context}</Text>
            ) : null}
          </Box>
        );
      })}
    </>
  );
}

const HELP_GROUPS: Array<{ title: string; actions: Action[] }> = [
  {
    title: "global",
    actions: [
      "help",
      "settings",
      "detach",
      "reload_config",
      "open_notification_target",
      "goto",
      "agent_desk",
      "toggle_sidebar",
    ],
  },
  {
    title: "navigation",
    actions: [
      "focus_pane_left",
      "focus_pane_down",
      "focus_pane_up",
      "focus_pane_right",
      "cycle_pane_next",
      "cycle_pane_previous",
      "last_pane",
      "previous_agent",
      "next_agent",
      "focus_agent",
    ],
  },
  {
    title: "workspaces and tabs",
    actions: [
      "workspace_picker",
      "new_workspace",
      "rename_workspace",
      "close_workspace",
      "previous_workspace",
      "next_workspace",
      "switch_workspace",
      "new_worktree",
      "open_worktree",
      "remove_worktree",
      "new_tab",
      "rename_tab",
      "previous_tab",
      "next_tab",
      "switch_tab",
      "move_tab_previous",
      "move_tab_next",
      "close_tab",
    ],
  },
  {
    title: "panes",
    actions: [
      "split_vertical",
      "split_horizontal",
      "close_pane",
      "zoom",
      "rename_pane",
      "swap_pane_left",
      "swap_pane_down",
      "swap_pane_up",
      "swap_pane_right",
      "resize_mode",
      "resize_pane_left",
      "resize_pane_down",
      "resize_pane_up",
      "resize_pane_right",
      "copy_mode",
      "edit_scrollback",
      "clear_pane",
    ],
  },
  {
    title: "shepherd",
    actions: [
      "plugin_actions",
      "refresh_machines",
      "remote_dashboard",
      "remote_panes",
      "remote_agents",
    ],
  },
];

/** Grouped list of bound keys, filtered by typing (Shepherd's prefix+?). */
export function HelpOverlay({
  keymap,
  filter,
  width,
  height,
}: {
  keymap: Keymap;
  filter: string;
  width: number;
  height: number;
}) {
  const needle = filter.toLowerCase();
  const rows: Array<{ group?: string; action?: string; keys?: string }> = [];
  for (const group of HELP_GROUPS) {
    const entries = group.actions
      .map((action) => ({
        action: action.replaceAll("_", " "),
        keys: (keymap.labels.get(action) ?? []).join(", "),
      }))
      .filter((entry) => entry.keys)
      .filter((entry) =>
        !needle ||
        entry.action.includes(needle) ||
        entry.keys.toLowerCase().includes(needle)
      );
    if (entries.length === 0) continue;
    rows.push({ group: group.title });
    rows.push(...entries);
  }
  const visible = rows.slice(0, Math.max(1, height - 6));
  return (
    <Box
      width={width}
      height={height}
      justifyContent="center"
      alignItems="center"
      borderStyle="round"
      borderColor={theme.brand}
      backgroundColor={theme.surface}
      overflow="hidden"
    >
      <Box flexDirection="column" width={Math.min(72, width - 4)}>
        <Text color={theme.brand} bold>keybindings</Text>
        <Text color={theme.muted}>
          / {filter || "type to filter"}
          <Text color={theme.brand}>▏</Text>
        </Text>
        {visible.map((row, index) => row.group ? (
          <Text key={index} color={theme.purple} bold>{row.group}</Text>
        ) : (
          <Box key={index} justifyContent="space-between">
            <Text color={theme.text}>  {row.action}</Text>
            <Text color={theme.cyan}>{row.keys}</Text>
          </Box>
        ))}
        <Text color={theme.muted}>Esc close · ctrl+u clear filter</Text>
      </Box>
    </Box>
  );
}

export function ConfirmOverlay({
  message,
  width,
  height,
}: {
  message: string;
  width: number;
  height: number;
}) {
  return (
    <Box
      width={width}
      height={height}
      justifyContent="center"
      alignItems="center"
      borderStyle="round"
      borderColor={theme.warning}
      backgroundColor={theme.surface}
    >
      <Box flexDirection="column" gap={1} width={Math.min(64, width - 4)}>
        <Text color={theme.warning} bold>{message}</Text>
        <Text color={theme.muted}>y / Enter confirm · n / Esc cancel</Text>
      </Box>
    </Box>
  );
}
