import { spawn } from "node:child_process";
import fs from "node:fs";
import type { AgentStatus } from "../types.js";

export type ToastKind = "needs attention" | "ready for review";
export type SoundKind = "request" | "done";

/** Shepherd's rules: blocked always asks for attention (with the request
 * sound); working/blocked → idle or done is a completion, skipped for the
 * tab the user is looking at while the terminal has focus. */
export function decideNotification(
  previous: AgentStatus | undefined,
  next: AgentStatus,
  suppressed: boolean,
): { toast: ToastKind | null; sound: SoundKind | null } {
  if (previous === next) return { toast: null, sound: null };
  if (next === "blocked") {
    return { toast: suppressed ? null : "needs attention", sound: "request" };
  }
  const completion = (next === "idle" || next === "done") &&
    (previous === "working" || previous === "blocked");
  if (completion && !suppressed) return { toast: "ready for review", sound: "done" };
  return { toast: null, sound: null };
}

export type TerminalNotifyBackend = "osc9" | "osc99" | null;

/** Terminals known to show desktop notifications for OSC 9 or OSC 99. */
export function terminalNotifyBackend(
  env: NodeJS.ProcessEnv = process.env,
): TerminalNotifyBackend {
  const program = env.TERM_PROGRAM;
  if (program === "ghostty" || program === "iTerm.app" || program === "WezTerm") {
    return "osc9";
  }
  if (env.KITTY_WINDOW_ID) return "osc99";
  const term = env.TERM ?? "";
  if (term === "xterm-ghostty" || term.includes("wezterm")) return "osc9";
  if (term === "xterm-kitty") return "osc99";
  return null;
}

const sanitize = (text: string) => text.replace(/[\x00-\x1f\x7f]/g, " ");

export function terminalNotification(
  backend: TerminalNotifyBackend,
  title: string,
  body: string,
  insideTmux = Boolean(process.env.TMUX),
): string | null {
  if (!backend) return null;
  let sequence: string;
  if (backend === "osc9") {
    const message = sanitize(body ? `${title}: ${body}` : title);
    sequence = `\x1b]9;${message}\x1b\\`;
  } else {
    sequence = body
      ? `\x1b]99;i=1:d=0;${sanitize(title)}\x1b\\\x1b]99;i=1:p=body;${sanitize(body)}\x1b\\`
      : `\x1b]99;;${sanitize(title)}\x1b\\`;
  }
  if (!insideTmux) return sequence;
  return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

/** Desktop notification through the OS: terminal-notifier or osascript on
 * macOS, notify-send on Linux. */
export function systemNotification(title: string, body: string): void {
  const run = (file: string, args: string[]) => {
    const child = spawn(file, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  };
  if (process.platform === "darwin") {
    if (commandExists("terminal-notifier")) {
      run("terminal-notifier", ["-title", title, "-message", body || " "]);
    } else {
      const quote = (value: string) => JSON.stringify(value);
      run("osascript", [
        "-e",
        `display notification ${quote(body || " ")} with title ${quote(title)}`,
      ]);
    }
  } else if (process.platform === "linux") {
    run("notify-send", [title, body]);
  }
}

/** Plays a sound file, or rings the terminal bell when none is set. */
export function playSound(file: string | null, bell: () => void): void {
  if (!file) {
    bell();
    return;
  }
  const player = process.platform === "darwin"
    ? ["afplay", [file]]
    : ["sh", ["-c", "command -v paplay >/dev/null && exec paplay \"$0\" || exec aplay -q \"$0\"", file]];
  const child = spawn(player[0] as string, player[1] as string[], {
    stdio: "ignore",
    detached: true,
  });
  child.on("error", () => bell());
  child.unref();
}

function commandExists(name: string): boolean {
  return (process.env.PATH ?? "").split(":").some((directory) => {
    try {
      fs.accessSync(`${directory}/${name}`, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
