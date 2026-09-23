import { memo } from "react";
import { Box, Text } from "ink";
import { displayWidth } from "./geometry.js";
import { theme } from "./theme.js";
import type { ChromeRow } from "./chrome.js";

/** One line of chrome: segments, padded to `width` with the row's
 * background, plus an optional trailing cell (the sidebar divider). */
export const ChromeLine = memo(function ChromeLine({
  row,
  width,
  trailing,
}: {
  row: ChromeRow;
  width: number;
  trailing?: { text: string; color?: string };
}) {
  const used = row.segments.reduce((total, segment) => total + displayWidth(segment.text), 0);
  const pad = Math.max(0, width - used);
  return (
    <Text wrap="truncate-end">
      {row.segments.map((segment, index) => (
        <Text
          key={index}
          color={segment.color}
          backgroundColor={segment.backgroundColor ?? row.background}
          bold={segment.bold}
          dimColor={segment.dim}
        >
          {segment.text}
        </Text>
      ))}
      {pad > 0 ? <Text backgroundColor={row.background}>{" ".repeat(pad)}</Text> : null}
      {trailing ? <Text color={trailing.color}>{trailing.text}</Text> : null}
    </Text>
  );
});

/** Shepherd's left sidebar: rows from `sidebarRows` and a `│` divider in the
 * last column. */
export function Sidebar({
  rows,
  width,
}: {
  rows: ChromeRow[];
  width: number;
}) {
  if (width <= 0) return null;
  return (
    <Box flexDirection="column" width={width} height={rows.length} overflow="hidden">
      {rows.map((row, index) => (
        <ChromeLine
          key={index}
          row={row}
          width={width - 1}
          trailing={{ text: "│", color: theme.surfaceDim }}
        />
      ))}
    </Box>
  );
}
