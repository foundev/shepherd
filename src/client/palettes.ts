// Built-in color palettes.
// null means the terminal default colour.

export interface ThemePalette {
  accent: string | null;
  panel_bg: string | null;
  sidebar_bg: string | null;
  active_row_bg: string | null;
  selection_bg: string | null;
  surface0: string | null;
  surface1: string | null;
  surface_dim: string | null;
  overlay0: string | null;
  overlay1: string | null;
  text: string | null;
  subtext0: string | null;
  mauve: string | null;
  green: string | null;
  yellow: string | null;
  red: string | null;
  blue: string | null;
  teal: string | null;
  peach: string | null;
}

export const PALETTES: Record<string, ThemePalette> = {
  "shepherd": {
    accent: "#b7a3ff",
    panel_bg: "#111318",
    sidebar_bg: "#17191f",
    active_row_bg: "#292536",
    selection_bg: "#3a3453",
    surface0: "#20232b",
    surface1: "#454b5b",
    surface_dim: "#191c23",
    overlay0: "#929aaa",
    overlay1: "#bec4d0",
    text: "#f0f1f5",
    subtext0: "#bac1cf",
    mauve: "#b7a3ff",
    green: "#83cf9b",
    yellow: "#efc278",
    red: "#ef8b93",
    blue: "#92baff",
    teal: "#88cfc4",
    peach: "#e1aa83",
  },
  "shepherd-day": {
    accent: "#6954a3",
    panel_bg: "#fbfafc",
    sidebar_bg: "#f0eef4",
    active_row_bg: "#e5e0f1",
    selection_bg: "#d5ccec",
    surface0: "#eeecf2",
    surface1: "#bab4c5",
    surface_dim: "#f4f2f7",
    overlay0: "#716c80",
    overlay1: "#504b5f",
    text: "#252332",
    subtext0: "#504b5f",
    mauve: "#6954a3",
    green: "#187d53",
    yellow: "#94610e",
    red: "#b43e4b",
    blue: "#356c9e",
    teal: "#087e75",
    peach: "#a95d36",
  },
};

interface ThemeSeed {
  background: string;
  foreground: string;
  accent: string;
  green: string;
  yellow: string;
  red: string;
  blue: string;
  teal: string;
  peach: string;
  mauve: string;
  light?: boolean;
}

function blend(first: string, second: string, amount: number): string {
  const channel = (start: number) => {
    const a = Number.parseInt(first.slice(start, start + 2), 16);
    const b = Number.parseInt(second.slice(start, start + 2), 16);
    return Math.round(a * (1 - amount) + b * amount).toString(16).padStart(2, "0");
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

function build(seed: ThemeSeed): ThemePalette {
  const { background: bg, foreground: fg, accent } = seed;
  const edge = seed.light ? "#ffffff" : "#000000";
  return {
    accent, panel_bg: bg,
    sidebar_bg: blend(bg, edge, 0.22),
    active_row_bg: blend(bg, accent, seed.light ? 0.12 : 0.19),
    selection_bg: blend(bg, accent, seed.light ? 0.24 : 0.32),
    surface0: blend(bg, fg, seed.light ? 0.06 : 0.09),
    surface1: blend(bg, fg, seed.light ? 0.18 : 0.22),
    surface_dim: blend(bg, edge, 0.1),
    overlay0: blend(bg, fg, 0.5), overlay1: blend(bg, fg, 0.7),
    text: fg, subtext0: blend(bg, fg, 0.72),
    mauve: seed.mauve, green: seed.green, yellow: seed.yellow,
    red: seed.red, blue: seed.blue, teal: seed.teal, peach: seed.peach,
  };
}

Object.assign(PALETTES, {
  aurora: build({ background: "#101b20", foreground: "#e8f5ed", accent: "#78e5ac", green: "#78e5ac", yellow: "#edce7c", red: "#f58f92", blue: "#92c6ed", teal: "#59d5ca", peach: "#efa981", mauve: "#c3a4e9" }),
  ember: build({ background: "#201716", foreground: "#f7e9dc", accent: "#f4a875", green: "#a7d6a2", yellow: "#f0ca79", red: "#ee8587", blue: "#a9bdef", teal: "#86cfc1", peach: "#f4a875", mauve: "#d3a6d4" }),
  midnight: build({ background: "#0c1224", foreground: "#e8edff", accent: "#80aaff", green: "#8fdac5", yellow: "#e8cf83", red: "#f590ac", blue: "#80aaff", teal: "#75d7e7", peach: "#efb28e", mauve: "#b99af8" }),
  orchid: build({ background: "#1b1525", foreground: "#f2eaf8", accent: "#c5a2f5", green: "#9edca9", yellow: "#ebcb8c", red: "#ed92ad", blue: "#a7b9f1", teal: "#8ed8d0", peach: "#eab09b", mauve: "#c5a2f5" }),
  glacier: build({ background: "#eff6f8", foreground: "#203840", accent: "#267e9b", green: "#268263", yellow: "#986d15", red: "#b34d60", blue: "#376da5", teal: "#188c8e", peach: "#a96142", mauve: "#795f9c", light: true }),
  parchment: build({ background: "#fbf4e7", foreground: "#3b312d", accent: "#9e5945", green: "#537c4e", yellow: "#946719", red: "#b1454a", blue: "#496b96", teal: "#327c76", peach: "#ac6845", mauve: "#805e90", light: true }),
  terminal: {
    accent: "blue", panel_bg: null, sidebar_bg: null, active_row_bg: null,
    selection_bg: null, surface0: null, surface1: null, surface_dim: null,
    overlay0: "gray", overlay1: "white", text: null, subtext0: "gray",
    mauve: "magenta", green: "green", yellow: "yellow", red: "red",
    blue: "blue", teal: "cyan", peach: "yellow",
  },
});
