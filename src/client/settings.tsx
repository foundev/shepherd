import type { ShepherdConfig } from "../config/model.js";
import { PALETTES } from "./palettes.js";
import { canonicalThemeName, theme } from "./theme.js";
import { centeredRect, Panel, PanelRows } from "./panels.js";
import type { ChromeRow, Segment } from "./chrome.js";

export const SETTINGS_TABS = ["theme", "indicators", "sound", "toast"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export interface SettingsState {
  tab: SettingsTab;
  selected: number;
}

export interface SettingsOption {
  label: string;
  /** TOML section, key and value written when chosen. */
  section: string;
  key: string;
  value: string | boolean;
  current: boolean;
}

export function settingsOptions(tab: SettingsTab, config: ShepherdConfig): SettingsOption[] {
  switch (tab) {
    case "theme": {
      const current = canonicalThemeName(config.theme.name);
      return Object.keys(PALETTES).map((name) => ({
        label: name,
        section: "theme",
        key: "name",
        value: name,
        current: name === current,
      }));
    }
    case "indicators":
      return (["dots", "symbols"] as const).map((value) => ({
        label: value === "dots" ? "dots  ● ● ● ○ ·" : "symbols  × ◐ ✓ ○ ·",
        section: "ui",
        key: "status_indicators",
        value,
        current: config.ui.status_indicators === value,
      }));
    case "sound":
      return [true, false].map((value) => ({
        label: value ? "on" : "off",
        section: "ui.sound",
        key: "enabled",
        value,
        current: config.ui.sound.enabled === value,
      }));
    case "toast":
      return ([
        ["off", "off"],
        ["shepherd", "inside shepherd"],
        ["terminal", "via terminal"],
        ["system", "via system"],
      ] as const).map(([value, label]) => ({
        label,
        section: "ui.toast",
        key: "delivery",
        value,
        current: config.ui.toast.delivery === value,
      }));
  }
}

/** Shepherd's settings overlay: tabs across the top, options below with a
 * check on the current value. */
export function SettingsOverlay({
  settings,
  config,
  columns,
  rows,
}: {
  settings: SettingsState;
  config: ShepherdConfig;
  columns: number;
  rows: number;
}) {
  const options = settingsOptions(settings.tab, config);
  const rect = centeredRect(columns, rows, 76, Math.min(rows - 2, options.length + 7));
  const inner = rect.width - 2;
  const tabs: Segment[] = [{ text: " " }];
  for (const tab of SETTINGS_TABS) {
    const active = tab === settings.tab;
    tabs.push({
      text: ` ${tab} `,
      color: active ? theme.panelContrast : theme.muted,
      backgroundColor: active ? theme.brand : undefined,
      bold: active,
    });
    tabs.push({ text: " " });
  }
  const listHeight = Math.max(1, rect.height - 2 - 4);
  const offset = Math.max(0, Math.min(settings.selected - listHeight + 1, options.length - listHeight));
  const list: ChromeRow[] = options.slice(offset, offset + listHeight).map((option, index) => {
    const selected = offset + index === settings.selected;
    const style = selected
      ? { color: theme.panelContrast, backgroundColor: theme.brand, bold: true }
      : { color: theme.text };
    return {
      background: selected ? theme.brand : undefined,
      segments: [
        { text: option.current ? " ✓ " : "   ", ...(selected ? style : { color: theme.success }) },
        { text: option.label, ...style },
      ],
    };
  });
  return (
    <Panel rect={rect} title="Settings">
      <PanelRows
        width={inner}
        rows={[
          { segments: tabs },
          { segments: [{ text: "─".repeat(inner), color: theme.surfaceDim }] },
          ...list,
          { segments: [] },
          {
            segments: [{
              text: " ←/→ tab · ↑/↓ choose · enter apply · esc close",
              color: theme.muted,
            }],
          },
        ]}
      />
    </Panel>
  );
}
