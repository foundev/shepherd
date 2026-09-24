import { PALETTES, type ThemePalette } from "./palettes.js";
import { terminalColor } from "./colors.js";

const initial = PALETTES.shepherd!;

/** UI colour tokens. Mutated in place by applyTheme so every component
 * picks up the configured theme on its next render. */
export const theme = {
  brand: initial.accent ?? "blue",
  brandMuted: initial.surface1 ?? "gray",
  background: initial.panel_bg ?? undefined,
  surface: initial.surface_dim ?? undefined,
  surfaceRaised: initial.surface0 ?? "gray",
  border: initial.surface1 ?? "gray",
  borderFocused: initial.accent ?? "blue",
  text: initial.text ?? undefined,
  primary: initial.text ?? undefined,
  muted: initial.overlay0 ?? "gray",
  success: initial.green ?? "green",
  warning: initial.yellow ?? "yellow",
  danger: initial.red ?? "red",
  purple: initial.mauve ?? "magenta",
  cyan: initial.teal ?? "cyan",
  selection: initial.selection_bg ?? "gray",
  activeRow: initial.active_row_bg ?? "gray",
  /** Palette tokens used by the chrome. */
  subtext: initial.subtext0 ?? undefined,
  overlay1: initial.overlay1 ?? "gray",
  surfaceDim: initial.surface_dim ?? "gray",
  surface0: initial.surface0 ?? "gray",
  panelBg: initial.panel_bg ?? undefined,
  /** Text drawn on accent backgrounds. */
  panelContrast: initial.panel_bg ?? "black",
  sidebarBg: initial.sidebar_bg ?? undefined,
};

/** Shepherd's agent status colours: blocked red, working yellow, done teal,
 * idle green. */
export const statusColor: Record<string, string> = {};
export const statusBackground: Record<string, string> = {};

export const THEME_ALIASES: Record<string, string> = {
  dark: "shepherd",
  day: "shepherd-day",
  light: "shepherd-day",
  night: "midnight",
  dawn: "parchment",
};

export function canonicalThemeName(name: string): string | null {
  const normalized = name.toLowerCase().replace(/[ _]/g, "-");
  const resolved = THEME_ALIASES[normalized] ?? normalized;
  return PALETTES[resolved] ? resolved : null;
}

const NAMED_COLORS: Record<string, string> = {
  black: "black",
  red: "red",
  green: "green",
  yellow: "yellow",
  blue: "blue",
  magenta: "magenta",
  purple: "magenta",
  cyan: "cyan",
  white: "white",
  gray: "gray",
  grey: "gray",
  darkgray: "gray",
  darkgrey: "gray",
  lightred: "redBright",
  lightgreen: "greenBright",
  lightyellow: "yellowBright",
  lightblue: "blueBright",
  lightmagenta: "magentaBright",
  lightcyan: "cyanBright",
};

/** Parses Shepherd colour syntax: #rrggbb, #rgb, rgb(r,g,b), named colours, or
 * reset/default/none/transparent (terminal default, returned as null).
 * Returns undefined for values it cannot parse. */
export function parseColor(value: string): string | null | undefined {
  const text = value.trim().toLowerCase();
  if (["reset", "default", "none", "transparent"].includes(text)) return null;
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  if (/^#[0-9a-f]{3}$/.test(text)) {
    return `#${[...text.slice(1)].map((digit) => digit + digit).join("")}`;
  }
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(text);
  if (rgb) {
    const parts = rgb.slice(1, 4).map(Number);
    if (parts.every((part) => part <= 255)) {
      return `#${parts.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
    }
  }
  return NAMED_COLORS[text];
}

/** Applies a built-in theme plus `[theme.custom]` overrides and `ui.accent`.
 * Returns diagnostics for unknown names or colours. */
export function applyTheme(
  name: string,
  custom: Record<string, string> = {},
  accent = "",
): string[] {
  const diagnostics: string[] = [];
  let resolved = canonicalThemeName(name);
  if (!resolved) {
    diagnostics.push(
      `unknown theme name theme.name = "${name}"; using "shepherd"`,
    );
    resolved = "shepherd";
  }
  const palette: ThemePalette = { ...(PALETTES[resolved] as ThemePalette) };
  const overrides: Record<string, string> = { ...custom };
  if (accent) overrides.accent = accent;
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in palette)) {
      if (key !== "light" && key !== "dark") {
        diagnostics.push(`theme.custom.${key}: unknown colour token`);
      }
      continue;
    }
    const parsed = parseColor(value);
    if (parsed === undefined) {
      diagnostics.push(`theme.custom.${key}: cannot parse colour "${value}"`);
      continue;
    }
    palette[key as keyof ThemePalette] = parsed;
  }

  for (const key of Object.keys(palette) as Array<keyof ThemePalette>) {
    const value = palette[key];
    if (value !== null) palette[key] = terminalColor(value)!;
  }

  const color = (value: string | null, fallback: string) => value ?? fallback;
  theme.brand = color(palette.accent, "blue");
  theme.brandMuted = color(palette.surface1, "gray");
  theme.background = palette.panel_bg ?? undefined;
  theme.surface = palette.surface_dim ?? palette.panel_bg ?? undefined;
  theme.surfaceRaised = color(palette.surface0, "gray");
  theme.border = color(palette.surface1, "gray");
  theme.borderFocused = color(palette.accent, "blue");
  theme.text = palette.text ?? undefined;
  theme.primary = palette.text ?? undefined;
  theme.muted = color(palette.overlay0, "gray");
  theme.success = color(palette.green, "green");
  theme.warning = color(palette.yellow, "yellow");
  theme.danger = color(palette.red, "red");
  theme.purple = color(palette.mauve, "magenta");
  theme.cyan = color(palette.teal, "cyan");
  theme.selection = color(palette.selection_bg, "gray");
  theme.activeRow = color(palette.active_row_bg, "gray");
  theme.subtext = palette.subtext0 ?? undefined;
  theme.overlay1 = color(palette.overlay1, "gray");
  theme.surfaceDim = color(palette.surface_dim, "gray");
  theme.surface0 = color(palette.surface0, "gray");
  theme.panelBg = palette.panel_bg ?? undefined;
  theme.panelContrast = palette.panel_bg ?? palette.surface_dim ?? "black";
  theme.sidebarBg = palette.sidebar_bg ?? undefined;

  Object.assign(statusColor, {
    blocked: theme.danger,
    working: theme.warning,
    done: theme.cyan,
    idle: theme.success,
    unknown: theme.muted,
  });
  const pill = color(palette.surface0, "gray");
  Object.assign(statusBackground, {
    blocked: pill,
    working: pill,
    done: pill,
    idle: pill,
    unknown: pill,
  });
  return diagnostics;
}

applyTheme("shepherd");
