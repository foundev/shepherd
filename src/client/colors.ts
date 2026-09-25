import chalk, { type ColorSupportLevel } from "chalk";
import { ANSI_COLORS } from "../ansiColors.js";

/** Keep palettes lossless until an attached client configures its output. */
let outputLevel: ColorSupportLevel = 3;

export function terminalColorLevel(
  env: NodeJS.ProcessEnv,
  isTTY: boolean,
  detected: ColorSupportLevel,
): ColorSupportLevel {
  // Explicit preferences take precedence over terminal identification.
  if (env.FORCE_COLOR !== undefined) {
    switch (env.FORCE_COLOR) {
      case "": case "true": case "1": return 1;
      case "2": return 2;
      case "3": return 3;
      default: return 0;
    }
  }
  if (env.NO_COLOR || env.NODE_DISABLE_COLORS || env.TERM === "dumb" || !isTTY) return 0;
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return 3;

  // Windows Terminal exports WT_SESSION into WSL, but COLORTERM can be empty.
  // Chalk sees Linux there and otherwise downgrades xterm-256color to 256.
  // An inherited host identity cannot establish a multiplexer/SSH's capability.
  const intermediary = env.TMUX || env.STY || env.SSH_TTY || env.SSH_CONNECTION ||
    /^(screen|tmux)(?:[-.]|$)/.test(env.TERM ?? "");
  if (env.WT_SESSION && !intermediary) return 3;
  return detected;
}

/** Configure the same Chalk instance Ink uses, before the first UI frame.
 * Does not change the environment inherited by the daemon or pane processes. */
export function configureTerminalColors(
  output: Pick<NodeJS.WriteStream, "isTTY"> = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  const previousChalk = chalk.level;
  const previousOutput = outputLevel;
  outputLevel = terminalColorLevel(env, Boolean(output.isTTY), chalk.level);
  chalk.level = outputLevel;
  return () => {
    chalk.level = previousChalk;
    outputLevel = previousOutput;
  };
}

const CUBE = [0, 95, 135, 175, 215, 255];
const EXTENDED_RGB = Array.from({ length: 240 }, (_, offset) => {
  if (offset >= 216) return Array<number>(3).fill(8 + (offset - 216) * 10);
  return [CUBE[Math.floor(offset / 36)], CUBE[Math.floor(offset / 6) % 6], CUBE[offset % 6]];
});
const cache = new Map<string, string>();

/** Shell prompts commonly use bold base ANSI colors for their bright variants.
 * Explicit RGB colors and backgrounds must not receive that promotion. */
export function terminalForegroundColor(color: string | undefined, bold = false): string | undefined {
  const index = color === undefined ? -1 : ANSI_COLORS.indexOf(color);
  return terminalColor(bold && index >= 0 && index < 8 ? ANSI_COLORS[index + 8] : color);
}

/** Select the closest actual palette entry, including the grayscale ramp.
 * Chalk rounds each RGB channel onto an evenly spaced cube, turning dark
 * navy into saturated blue. Pass an explicit index to bypass that conversion.
 * The first 16 entries are user-defined, so avoid them in 256-color mode. */
export function terminalColor(
  color: string | undefined,
  level: ColorSupportLevel = outputLevel,
): string | undefined {
  if (!color || level !== 2 || !/^#[\da-f]{6}$/i.test(color)) return color;
  const cached = cache.get(color);
  if (cached) return cached;

  const rgb = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
  let best = 0;
  let distance = Infinity;
  for (let index = 0; index < EXTENDED_RGB.length; index += 1) {
    const candidate = EXTENDED_RGB[index]!;
    const next = rgb.reduce((total, value, channel) => total + (value - candidate[channel]!) ** 2, 0);
    if (next < distance) {
      best = index;
      distance = next;
    }
  }
  const result = `ansi256(${best + 16})`;
  // Pane applications can emit arbitrarily many RGB colors.
  if (cache.size >= 4096) cache.clear();
  cache.set(color, result);
  return result;
}
