/** The host terminal owns the first 16 palette entries. Keep their identity
 * through parsing, rendering, and screen replay instead of baking in RGB. */
export const ANSI_COLORS: readonly string[] = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "blackBright", "redBright", "greenBright", "yellowBright",
  "blueBright", "magentaBright", "cyanBright", "whiteBright",
];
