import { Box, Text } from "ink";
import { statusBackground, statusColor, theme } from "./theme.js";
import { StatusBadge } from "./indicators.js";
import type { Action, Keymap } from "../config/keybinds.js";
import type { ToastPosition } from "../config/model.js";
import type { AgentStatus, Rect } from "../types.js";

export interface ToastEntry {
  id: string;
  title: string;
  context: string;
  tone: "attention" | "done" | "clipboard";
  position: ToastPosition;
  paneId?: string;
  status?: AgentStatus;
}

/** A compact notification in existing chrome; explicit corner positions
 * retain their floating cards. */
export function ToastStack({
  toasts,
  columns,
  rows,
  barRect,
  openLabel,
}: {
  toasts: ToastEntry[];
  columns: number;
  rows: number;
  barRect: Rect;
  openLabel?: string;
}) {
  const width = Math.max(4, Math.min(44, columns - 2));
  const floating = toasts.filter((toast) => toast.position !== "bar");
  const barToasts = toasts.filter((toast) => toast.position === "bar");
  const latest = barToasts.at(-1);
  const latestStatus = latest ? toastStatus(latest) : "unknown";
  return (
    <>
      {latest && (
        <Box
          position="absolute"
          marginLeft={barRect.x}
          marginTop={barRect.y}
          width={barRect.width}
          height={1}
          backgroundColor={statusBackground[latestStatus]}
        >
          <Text wrap="truncate-end">
            <StatusBadge status={latestStatus} compact />
            <Text color={theme.text} bold>{latest.title}</Text>
            <Text color={theme.subtext}>
              {latest.context ? ` · ${latest.context}` : ""}
              {barToasts.length > 1 ? ` · +${barToasts.length - 1}` : ""}
            </Text>
            {latest.paneId && openLabel && (
              <Text color={theme.subtext}>
                {" · "}<Text color={statusColor[latestStatus]} bold>{openLabel}</Text>{" open"}
              </Text>
            )}
          </Text>
        </Box>
      )}
      {floating.map((toast, index) => {
        const height = toast.context ? 4 : 3;
        const fromBottom = floating.length - index;
        const top = toast.position.startsWith("top")
          ? 1 + index * height
          : Math.max(0, rows - 1 - fromBottom * height);
        const left = toast.position.endsWith("left")
          ? 1
          : toast.position.endsWith("center")
            ? Math.max(0, Math.floor((columns - width) / 2))
            : Math.max(0, columns - width - 1);
        const status = toastStatus(toast);
        const color = statusColor[status];
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
            backgroundColor={theme.panelBg}
            flexDirection="column"
            overflow="hidden"
          >
            <Box height={1} backgroundColor={statusBackground[status]}>
              <Text wrap="truncate-end">
                <StatusBadge status={status} compact />
                <Text color={theme.text} bold>{` ${toast.title}`}</Text>
              </Text>
            </Box>
            {toast.context ? (
              <Text color={theme.subtext} wrap="truncate-end">{`    ${toast.context}`}</Text>
            ) : null}
          </Box>
        );
      })}
    </>
  );
}

function toastStatus(toast: ToastEntry): AgentStatus {
  return toast.status ?? (toast.tone === "attention" ? "blocked" : "done");
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
      "toggle_agent_sort",
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
      backgroundColor={theme.panelBg}
      overflow="hidden"
    >
      <Box flexDirection="column" width={Math.max(1, Math.min(72, width - 4))}>
        <Box height={1}>
          <Text color={theme.panelContrast} backgroundColor={theme.brand} bold>{" keybindings "}</Text>
        </Box>
        <Box height={1} backgroundColor={theme.surfaceRaised}>
          <Text color={theme.brand} bold>{" / "}</Text>
          <Text color={filter ? theme.text : theme.muted} wrap="truncate-end">
            {filter || "type to filter"}<Text color={theme.brand}>▏</Text>
          </Text>
        </Box>
        {visible.map((row, index) => row.group ? (
          <Text key={index} color={theme.purple} bold wrap="truncate-end">{row.group}</Text>
        ) : (
          <Box key={index} justifyContent="space-between" height={1} overflow="hidden">
            <Text color={theme.text} wrap="truncate-end">  {row.action}</Text>
            <Box flexShrink={0}>
              <Text color={theme.cyan} backgroundColor={theme.surfaceRaised}>{` ${row.keys} `}</Text>
            </Box>
          </Box>
        ))}
        <Text color={theme.muted} wrap="truncate-end">
          <Text color={theme.subtext}>Esc</Text>{" close · "}
          <Text color={theme.subtext}>ctrl+u</Text>{" clear filter"}
        </Text>
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
      backgroundColor={theme.panelBg}
      overflow="hidden"
    >
      <Box flexDirection="column" gap={1} width={Math.max(1, Math.min(64, width - 4))}>
        <Text color={theme.text} bold>
          <Text color={theme.panelContrast} backgroundColor={theme.warning}>{" ! "}</Text>{` ${message}`}
        </Text>
        <Text color={theme.subtext} wrap="truncate-end">
          <Text color={theme.panelContrast} backgroundColor={theme.warning} bold>{" y / Enter "}</Text>
          {" confirm · "}<Text color={theme.text} backgroundColor={theme.surfaceRaised}>{" n / Esc "}</Text>{" cancel"}
        </Text>
      </Box>
    </Box>
  );
}
