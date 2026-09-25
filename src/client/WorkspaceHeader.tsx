import { Box, Text } from "ink";
import { deskEntries, type DeskLane } from "../agentDesk.js";
import type { StateView } from "../types.js";
import { fit, truncateText, workspaceLabel, type ChromeRow, type ClickTarget, type Segment } from "./chrome.js";
import { displayWidth } from "./geometry.js";
import { theme } from "./theme.js";

const segmentWidth = (segments: Segment[]): number =>
  segments.reduce((sum, segment) => sum + displayWidth(segment.text), 0);

/** Reserve the right-hand content before fitting the workspace name or path. */
function dividedRow(left: Segment[], right: Segment[], width: number): ChromeRow {
  const inset = Math.min(2, Math.floor(width / 2));
  const innerWidth = Math.max(0, width - inset * 2);
  const rightWidth = segmentWidth(right);
  const leftWidth = Math.max(0, innerWidth - rightWidth - (rightWidth ? 3 : 0));
  const fitted = fit(left, leftWidth);
  return {
    background: theme.panelBg,
    segments: [
      { text: " ".repeat(inset) },
      ...fitted,
      { text: " ".repeat(Math.max(0, innerWidth - segmentWidth(fitted) - rightWidth)) },
      ...right,
      { text: " ".repeat(inset) },
    ],
  };
}

function activitySegments(state: StateView, budget: number): { segments: Segment[]; total: number } {
  const entries = deskEntries(state);
  const counts = new Map<DeskLane, number>();
  for (const entry of entries) counts.set(entry.lane, (counts.get(entry.lane) ?? 0) + 1);
  const lanes: Array<{ lane: DeskLane; label: string; color: string }> = [
    { lane: "blocked", label: "needs you", color: theme.danger },
    { lane: "review", label: "review", color: theme.cyan },
    { lane: "unknown", label: "check status", color: theme.muted },
    { lane: "working", label: "working", color: theme.warning },
    { lane: "ready", label: "ready", color: theme.success },
  ];
  const target: ClickTarget = { kind: "agent-sort" };
  const segments: Segment[] = [];
  for (const { lane, label, color } of lanes) {
    const count = counts.get(lane) ?? 0;
    if (!count) continue;
    const item: Segment[] = [
      ...(segments.length ? [{ text: "   ", target }] : []),
      { text: String(count), color, bold: true, target },
      { text: ` ${label}`, color: theme.subtext, target },
    ];
    // Never show half a metric. The smaller layouts retain the urgent lane.
    if (segmentWidth(segments) + segmentWidth(item) > budget) break;
    segments.push(...item);
  }
  if (!entries.length && budget >= 9) {
    segments.push({ text: "no agents", color: theme.muted, target });
  }
  return { segments, total: entries.length };
}

/** The desktop workspace identity and live, session-wide attention overview.
 * This same row model supplies pointer targets to the application. */
export function workspaceHeaderRows(state: StateView, width: number, height = 3): ChromeRow[] {
  width = Math.max(0, Math.floor(width));
  height = Math.max(0, Math.floor(height));
  if (!height) return [];
  const workspace = state.workspaces.find((entry) => entry.id === state.activeWorkspaceId);
  const target: ClickTarget | undefined = workspace ? { kind: "workspace", id: workspace.id } : undefined;
  const summaryBudget = width >= 46 ? Math.min(76, Math.floor(width * 0.57)) : 0;
  const activity = activitySegments(state, summaryBudget);
  const title: Segment[] = [
    { text: workspace ? workspaceLabel(workspace) : "Shepherd", color: theme.text, bold: true, target },
  ];
  if (workspace?.git?.branch) {
    title.push(
      { text: "  /  ", color: theme.border },
      { text: workspace.git.branch, color: theme.subtext, target },
    );
  }
  const titleRow = dividedRow(title, activity.segments, width);
  const detail: Segment[] = workspace
    ? [{ text: workspace.rootPath, color: theme.muted, target }]
    : [{ text: state.session, color: theme.muted }];
  const context: Segment[] = width >= 60 && activity.total > 0
    ? [{ text: `${activity.total} ${activity.total === 1 ? "agent" : "agents"} across your workspaces`, color: theme.muted }]
    : [];
  const detailRow = dividedRow(detail, context, width);
  const blank: ChromeRow = { segments: [{ text: " ".repeat(width) }], background: theme.panelBg };
  if (height === 1) return [titleRow];
  if (height === 2) return [titleRow, detailRow];
  return [blank, titleRow, detailRow, ...Array.from({ length: height - 3 }, () => blank)];
}

export interface FooterHint {
  /** The actual configured binding, with any prefix already removed. */
  key: string;
  label: string;
  target?: ClickTarget;
}

export interface WorkspaceFooterOptions {
  width: number;
  prefix: string;
  hints?: FooterHint[];
  message?: string;
  session?: string;
}

/** A quiet command rail. Only complete hints are shown as space permits. */
export function workspaceFooterRow({ width, prefix, hints = [], message, session }: WorkspaceFooterOptions): ChromeRow {
  width = Math.max(0, Math.floor(width));
  const inset = Math.min(2, Math.floor(width / 2));
  const left: Segment[] = [];
  const menu: ClickTarget = { kind: "menu" };
  if (message) {
    left.push({ text: message, color: theme.subtext });
  } else {
    left.push(
      { text: prefix, color: theme.brand, bold: true, target: menu },
      { text: " commands", color: theme.subtext, target: menu },
    );
    for (const hint of hints) {
      if (!hint.key) continue;
      const item: Segment[] = [
        { text: "   " },
        { text: hint.key, color: theme.subtext, target: hint.target },
        { text: ` ${hint.label}`, color: theme.muted, target: hint.target },
      ];
      if (segmentWidth(left) + segmentWidth(item) > width - inset * 2) break;
      left.push(...item);
    }
  }
  // Session context yields first, preserving actionable shortcuts.
  const right: Segment[] = session && width - segmentWidth(left) >= displayWidth(session) + 9
    ? [{ text: truncateText(session, 30), color: theme.muted }]
    : [];
  return { ...dividedRow(left, right, width), background: theme.sidebarBg };
}

function HeaderLine({ row, width }: { row: ChromeRow; width: number }) {
  return (
    <Box width={width} height={1} flexShrink={0} backgroundColor={row.background}>
      <Text wrap="truncate-end">
        {row.segments.map((segment, index) => (
          <Text key={index} color={segment.color} backgroundColor={segment.backgroundColor ?? row.background}
            bold={segment.bold} dimColor={segment.dim}>{segment.text}</Text>
        ))}
      </Text>
    </Box>
  );
}

export function WorkspaceHeader({ state, width, height = 3 }: { state: StateView; width: number; height?: number }) {
  return (
    <Box width={width} height={height} flexDirection="column" flexShrink={0} overflow="hidden" backgroundColor={theme.panelBg}>
      {workspaceHeaderRows(state, width, height).map((row, index) => <HeaderLine key={index} row={row} width={width} />)}
    </Box>
  );
}

export function WorkspaceFooter(options: WorkspaceFooterOptions) {
  return <HeaderLine row={workspaceFooterRow(options)} width={options.width} />;
}
