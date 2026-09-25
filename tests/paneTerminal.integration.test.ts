import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  PaneTerminal,
  clipboardFromOsc52,
  cwdFromOsc7,
  paneEnvironment,
} from "../src/server/terminal.js";
import { SurfaceSubscription } from "../src/server/surfaces.js";
import { isShellLike } from "../src/client/surfaces.js";

const panes: PaneTerminal[] = [];
const originalShell = process.env.SHELL;

// The scripted apps below use bash's `read` options.
beforeAll(() => {
  process.env.SHELL = "/bin/bash";
});

afterAll(() => {
  process.env.SHELL = originalShell;
});

function pane(command: string, onExit?: (code: number) => void): PaneTerminal {
  const created = new PaneTerminal({
    id: `test-${panes.length}`,
    title: "test",
    cwd: os.tmpdir(),
    command,
    onExit,
  });
  panes.push(created);
  return created;
}

function screen(target: PaneTerminal): string {
  return target.snapshot(30, "recent")
    .map((line) => line.map((span) => span.text).join(""))
    .join("\n");
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for pane");
}

async function screenContaining(
  target: PaneTerminal,
  expected: string,
): Promise<string> {
  await until(() => screen(target).includes(expected)).catch(() => {
    throw new Error(`screen never contained ${expected}:\n${screen(target)}`);
  });
  return screen(target);
}

afterEach(() => {
  for (const entry of panes.splice(0)) entry.close();
});

describe("pane terminal", () => {
  it("preserves shell palette colors, bold, and explicit RGB through history replay", async () => {
    const colors = [
      "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
      "blackBright", "redBright", "greenBright", "yellowBright",
      "blueBright", "magentaBright", "cyanBright", "whiteBright",
    ];
    const palette = colors.map((_, index) => {
      const foreground = index < 8 ? 30 + index : 90 + index - 8;
      return `\\033[${foreground};${foreground + 10}m${String.fromCharCode(65 + index)}`;
    }).join("");
    const target = pane(
      `printf '${palette}\\033[0;1;32muser\\033[0m:` +
      "\\033[1;34mdir\\033[0m " +
      "\\033[38;2;0;0;128;48;2;16;23;34mrgb\\033[0m " +
      "\\033[38;5;24mindexed\\033[0m done'; sleep 5",
    );
    await screenContaining(target, "done");
    const lines = target.snapshot(30, "recent").filter((line) => line.length > 0);
    const spans = lines.flat();
    for (const [index, color] of colors.entries()) {
      expect(spans).toContainEqual(expect.objectContaining({
        text: String.fromCharCode(65 + index), color, backgroundColor: color,
      }));
    }
    expect(spans).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "user", color: "green", bold: true }),
      expect.objectContaining({ text: "dir", color: "blue", bold: true }),
      expect.objectContaining({ text: "rgb", color: "#000080", backgroundColor: "#101722" }),
      expect.objectContaining({ text: "indexed", color: "#005f87" }),
      expect.objectContaining({ text: expect.stringMatching(/^ done\s*$/), color: undefined }),
    ]));

    const restored = new PaneTerminal({
      id: "restored-colors", title: "restored", cwd: os.tmpdir(),
      command: "sleep 5", replay: target.historyAnsi()!,
    });
    panes.push(restored);
    await screenContaining(restored, "done");
    expect(restored.snapshot(30, "recent").filter((line) => line.length > 0)).toEqual(lines);
  });

  it("answers cursor position queries from the app", async () => {
    const target = pane(
      "printf 'ab\\033[6n'; IFS= read -rs -d R reply; " +
        "printf ' got:%s' \"${reply#?}\"; sleep 5",
    );
    expect(await screenContaining(target, "got:")).toContain("got:[1;3");
  });

  it("uses application cursor keys when the app enables DECCKM", async () => {
    const target = pane(
      "printf '\\033[?1h'; IFS= read -rs -n 3 key; " +
        "printf 'key:%s' \"${key#?}\"; sleep 5",
    );
    await until(() => target.modes.applicationCursorKeys);
    target.input("\x1b[A");
    expect(await screenContaining(target, "key:")).toContain("key:OA");
  });

  it("wraps pastes only when the app enabled bracketed paste", async () => {
    const target = pane(
      "printf '\\033[?2004h'; IFS= read -rs -d '~' a; IFS= read -rs -d '~' b; " +
        "printf 'paste:%s|%s' \"${a#?}\" \"${b%?????}\"; sleep 5",
    );
    await until(() => target.modes.bracketedPaste);
    target.paste("hi");
    expect(await screenContaining(target, "paste:"))
      .toContain("paste:[200|hi");
  });

  it("reports its own exit but not an explicit close", async () => {
    const exits: number[] = [];
    pane("exit 3", (code) => exits.push(code));
    await until(() => exits.length > 0);
    expect(exits).toEqual([3]);

    const closed: number[] = [];
    pane("sleep 5", (code) => closed.push(code)).close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(closed).toEqual([]);
  });

  it("scrolls one client's view without moving the live screen", async () => {
    const target = pane("seq 1 200; sleep 5");
    await until(() => screen(target).includes("200"));
    const subscription = new SurfaceSubscription(target.id, target.cols, target.rows);
    const live = subscription.frame(target);
    expect(live?.scroll.offsetFromBottom).toBe(0);

    subscription.scrollBy(-10, target);
    const scrolled = subscription.frame(target);
    expect(scrolled?.scroll.offsetFromBottom).toBe(10);
    expect(scrolled?.cursor.visible).toBe(false);
    expect(target.scrollState().offsetFromBottom).toBe(0);

    expect(subscription.followLive()).toBe(true);
    expect(subscription.frame(target)?.scroll.offsetFromBottom).toBe(0);
  });

  it("delivers OSC 52 clipboard writes from the app", async () => {
    const copied: string[] = [];
    const target = new PaneTerminal({
      id: "clip",
      title: "clip",
      cwd: os.tmpdir(),
      command: "printf '\\033]52;c;aGVsbG8=\\007'; sleep 5",
      onClipboard: (text) => copied.push(text),
    });
    panes.push(target);
    await until(() => copied.length > 0);
    expect(copied).toEqual(["hello"]);
  });

  it("finds OSC 8 hyperlinks and wrapped plain URLs under a cell", async () => {
    const target = new PaneTerminal({
      id: "links",
      title: "links",
      cwd: os.tmpdir(),
      command: "printf 'see \\033]8;;https://example.com/docs\\033\\\\here\\033]8;;\\033\\\\ and https://shepherd.dev/a/very/long/path/that/wraps/over/the/edge/of/the/pane.\\n'; sleep 5",
      initialCols: 40,
      initialRows: 10,
    });
    panes.push(target);
    await until(() => screen(target).includes("pane."));
    expect(target.linkAt(0, 5)).toBe("https://example.com/docs");
    expect(target.linkAt(0, 1)).toBeNull();
    // The plain URL starts on row 0 and wraps onto row 1.
    expect(target.linkAt(1, 3)).toBe(
      "https://shepherd.dev/a/very/long/path/that/wraps/over/the/edge/of/the/pane",
    );
  });

  it("tracks the working directory reported through OSC 7", async () => {
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "osc7-")),
    );
    const target = pane(
      `printf '\\033]7;file://host${directory}\\007'; sleep 5`,
    );
    await until(() => target.currentCwd === directory);
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

describe("pane environment", () => {
  it("advertises Shepherd and strips other multiplexers", () => {
    const env = paneEnvironment("p9", {}, {
      PATH: "/bin",
      TMUX: "/tmp/tmux",
      TMUX_PANE: "%1",
      ZELLIJ: "0",
    });
    expect(env).toMatchObject({
      PATH: "/bin",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "shepherd",
      SHEPHERD_PANE_ID: "p9",
    });
    expect(env.TMUX).toBeUndefined();
    expect(env.TMUX_PANE).toBeUndefined();
    expect(env.ZELLIJ).toBeUndefined();
  });

  it("parses OSC 52 clipboard writes and ignores queries", () => {
    expect(clipboardFromOsc52("c;aGVsbG8=")).toBe("hello");
    expect(clipboardFromOsc52(";aGk=")).toBe("hi");
    expect(clipboardFromOsc52("c;?")).toBeNull();
  });

  it("treats shell prompts, not full-screen apps, as scrollable", () => {
    const base = {
      applicationCursorKeys: false,
      bracketedPaste: true,
      mouseTracking: "none" as const,
      sendFocus: false,
      alternateScreen: false,
    };
    expect(isShellLike(base)).toBe(true);
    expect(isShellLike({ ...base, alternateScreen: true })).toBe(false);
    expect(isShellLike({ ...base, mouseTracking: "vt200" })).toBe(false);
    expect(isShellLike({
      ...base,
      applicationCursorKeys: true,
      bracketedPaste: false,
    })).toBe(false);
  });

  it("parses OSC 7 file URLs", () => {
    expect(cwdFromOsc7("file://host/Users/me/some%20dir"))
      .toBe("/Users/me/some dir");
    expect(cwdFromOsc7("http://example.com/x")).toBeNull();
  });
});
