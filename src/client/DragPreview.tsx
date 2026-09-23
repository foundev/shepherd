import { Box, Text } from "ink";
import { truncateText } from "./chrome.js";
import { theme } from "./theme.js";

export interface DragPreviewState {
  kind: "workspace" | "tab" | "pane";
  title: string;
  x: number;
  y: number;
  canDrop: boolean;
}

/** A drag ghost rendered by Ink, separate from terminal pane mouse input. */
export function DragPreview({
  drag,
  columns,
  rows,
}: {
  drag: DragPreviewState;
  columns: number;
  rows: number;
}) {
  const width = Math.min(30, Math.max(12, columns - 2));
  const left = Math.max(0, Math.min(columns - width, drag.x + 1));
  const top = Math.max(0, Math.min(rows - 3, drag.y + 1));
  const color = drag.canDrop ? theme.success : theme.brand;
  const verb = drag.kind === "pane" ? "SWAP" : "MOVE";

  return (
    <Box
      position="absolute"
      marginLeft={left}
      marginTop={top}
      width={width}
      height={3}
      borderStyle="round"
      borderColor={color}
      backgroundColor={theme.surfaceRaised}
      paddingX={1}
    >
      <Text wrap="truncate-end">
        <Text color={color} bold>{drag.canDrop ? `✓ ${verb} ` : `◇ ${verb} `}</Text>
        <Text color={theme.text}>{truncateText(drag.title, width - verb.length - 7)}</Text>
      </Text>
    </Box>
  );
}
