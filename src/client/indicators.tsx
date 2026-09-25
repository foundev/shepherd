import { useSyncExternalStore } from "react";
import { Text } from "ink";
import type { AgentStatus } from "../types.js";
import type { Segment } from "./chrome.js";
import { displayWidth } from "./geometry.js";
import { statusColor, statusForeground } from "./theme.js";

const WORKING_FRAMES = ["◐", "◓", "◑", "◒"];
const GLYPHS: Record<AgentStatus, string> = {
  blocked: "×", working: "◐", done: "◇", idle: "○", unknown: "·",
};

let activityFrame = 0;
let activityTimer: ReturnType<typeof setInterval> | undefined;
const activityListeners = new Set<() => void>();
const activitySnapshot = () => activityFrame;
const staticSnapshot = () => 0;

function subscribeActivity(listener: () => void): () => void {
  activityListeners.add(listener);
  if (!activityTimer) {
    activityTimer = setInterval(() => {
      activityFrame = (activityFrame + 1) % WORKING_FRAMES.length;
      activityListeners.forEach((notify) => notify());
    }, 800);
    activityTimer.unref?.();
  }
  return () => {
    activityListeners.delete(listener);
    if (activityListeners.size === 0) {
      clearInterval(activityTimer);
      activityTimer = undefined;
      activityFrame = 0;
    }
  };
}

interface BadgeOptions {
  compact?: boolean;
  pulse?: number;
  label?: string;
  solid?: boolean;
  animate?: boolean;
}

/** Shared cell model for Ink badges and mouse-aware chrome. */
export function statusBadgeSegments(status: AgentStatus, options: BadgeOptions = {}): Segment[] {
  const { compact = false, pulse = 0, solid = false, animate = false } = options;
  const glyph = status === "working" ? WORKING_FRAMES[pulse % WORKING_FRAMES.length]! : GLYPHS[status];
  const label = options.label ?? (status === "done" ? "REVIEW" : status.toUpperCase());
  const icon: Segment = {
    text: ` ${glyph}${compact ? " " : ""}`,
    color: solid ? statusForeground[status] : statusColor[status],
    backgroundColor: solid ? statusColor[status] : undefined,
    bold: true,
    animate: animate && status === "working",
  };
  if (compact) return [icon];
  return [icon, {
    text: ` ${label} `,
    color: solid ? statusForeground[status] : statusColor[status],
    backgroundColor: solid ? statusColor[status] : undefined,
    bold: true,
  }];
}

export function statusBadgeWidth(status: AgentStatus, compact = false): number {
  return statusBadgeSegments(status, { compact }).reduce((width, segment) => width + displayWidth(segment.text), 0);
}

/** A quiet, fixed-width activity cue. Its clock only renders this Ink leaf. */
export function AnimatedIndicator({ text }: { text: string }) {
  const frame = useSyncExternalStore(subscribeActivity, activitySnapshot, staticSnapshot);
  return <>{text.replace(/[◐◓◑◒]/u, WORKING_FRAMES[frame]!)}</>;
}

/** Native Ink status marker; a solid fill is reserved for explicit emphasis. */
export function StatusBadge({ status, ...options }: BadgeOptions & { status: AgentStatus }) {
  return <Text>{statusBadgeSegments(status, options).map((segment, index) => (
    <Text key={index} color={segment.color} backgroundColor={segment.backgroundColor} bold>
      {segment.animate ? <AnimatedIndicator text={segment.text} /> : segment.text}
    </Text>
  ))}</Text>;
}
