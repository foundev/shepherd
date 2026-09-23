import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";
import { displayWidth } from "./geometry.js";
import { truncateText, type ChromeRow } from "./chrome.js";
import { ChromeLine } from "./Sidebar.js";
import type { Rect } from "../types.js";

/** Rect of a panel centred on the screen. */
export function centeredRect(
  columns: number,
  rows: number,
  width: number,
  height: number,
): Rect {
  const w = Math.max(4, Math.min(columns, width));
  const h = Math.max(3, Math.min(rows, height));
  return {
    x: Math.max(0, Math.floor((columns - w) / 2)),
    y: Math.max(0, Math.floor((rows - h) / 2)),
    width: w,
    height: h,
  };
}

/** A floating panel in Shepherd's style: rounded border in the accent colour,
 * an optional title set into the top edge, panel background. Children are
 * the inner rows. */
export function Panel({
  rect,
  title,
  children,
  borderColor = theme.brand,
}: {
  rect: Rect;
  title?: string;
  children: ReactNode;
  borderColor?: string;
}) {
  const inner = Math.max(0, rect.width - 2);
  const label = title ? ` ${truncateText(title, Math.max(0, inner - 2))} ` : "";
  const top = `╭─${label}${"─".repeat(Math.max(0, inner - 1 - displayWidth(label)))}╮`;
  return (
    <Box
      position="absolute"
      marginLeft={rect.x}
      marginTop={rect.y}
      width={rect.width}
      height={rect.height}
      flexDirection="column"
    >
      <Text color={borderColor} backgroundColor={theme.panelBg}>{top}</Text>
      <Box flexDirection="row" height={rect.height - 2}>
        <Box flexDirection="column" width={1}>
          {Array.from({ length: rect.height - 2 }, (_, index) => (
            <Text key={index} color={borderColor} backgroundColor={theme.panelBg}>│</Text>
          ))}
        </Box>
        <Box
          flexDirection="column"
          width={inner}
          height={rect.height - 2}
          backgroundColor={theme.panelBg}
          overflow="hidden"
        >
          {children}
        </Box>
        <Box flexDirection="column" width={1}>
          {Array.from({ length: rect.height - 2 }, (_, index) => (
            <Text key={index} color={borderColor} backgroundColor={theme.panelBg}>│</Text>
          ))}
        </Box>
      </Box>
      <Text color={borderColor} backgroundColor={theme.panelBg}>
        {`╰${"─".repeat(inner)}╯`}
      </Text>
    </Box>
  );
}

export interface MenuItem {
  label: string;
  /** Accent dot before the label (attention items have an accent dot). */
  badge?: boolean;
  run: () => void;
}

export interface MenuState {
  items: MenuItem[];
  x: number;
  y: number;
  selected: number;
}

/** Rect for a menu opened at (x, y), clamped to the screen. */
export function menuRect(menu: MenuState, columns: number, rows: number): Rect {
  const labelWidth = Math.max(...menu.items.map((item) =>
    displayWidth(item.label) + (item.badge ? 2 : 0)
  ), 0);
  const width = Math.min(columns, Math.max(labelWidth + 4, 14));
  const height = Math.min(rows, menu.items.length + 2);
  return {
    x: Math.max(0, Math.min(columns - width, menu.x)),
    y: Math.max(0, Math.min(rows - height, menu.y)),
    width,
    height,
  };
}

export function MenuOverlay({
  menu,
  columns,
  rows,
}: {
  menu: MenuState;
  columns: number;
  rows: number;
}) {
  const rect = menuRect(menu, columns, rows);
  const inner = rect.width - 2;
  return (
    <Panel rect={rect}>
      <PanelRows
        width={inner}
        rows={menu.items.map((item, index) => {
          const selected = index === menu.selected;
          const style = selected
            ? { color: theme.panelContrast, backgroundColor: theme.brand, bold: true }
            : { color: theme.text };
          return {
            background: selected ? theme.brand : undefined,
            segments: [
              ...(item.badge
                ? [{ text: " ●", color: selected ? theme.panelContrast : theme.brand }]
                : []),
              { text: ` ${item.label}`, ...style },
            ],
          };
        })}
      />
    </Panel>
  );
}

/** Inner rows of a panel, each padded to the inner width. */
export function PanelRows({ rows, width }: { rows: ChromeRow[]; width: number }) {
  return (
    <>
      {rows.map((row, index) => (
        <ChromeLine
          key={index}
          row={{ ...row, background: row.background ?? theme.panelBg }}
          width={width}
        />
      ))}
    </>
  );
}
