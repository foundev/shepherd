import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { decodeKey, paneKeyBytes } from "../src/client/input.js";
import { KittyKeyboardState } from "../src/server/kittyKeyboard.js";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as typeof import("@xterm/headless");

function emulator() {
  const terminal = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
  const state = new KittyKeyboardState();
  const replies: string[] = [];
  state.attach(terminal, (data) => replies.push(data));
  const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
  return { state, replies, write };
}

describe("kitty keyboard state", () => {
  it("tracks pushes, pops, sets, queries and resets", async () => {
    const { state, replies, write } = emulator();
    await write("\x1b[>1u\x1b[>3u");
    expect(state.flags).toBe(3);
    await write("\x1b[?u");
    expect(replies).toEqual(["\x1b[?3u"]);
    expect(state.replay()).toBe("\x1b[>1u\x1b[>3u");
    await write("\x1b[<u");
    expect(state.flags).toBe(1);
    await write("\x1b[=5u");
    expect(state.flags).toBe(5);
    await write("\x1b[<9u");
    expect(state.flags).toBe(0);
    await write("\x1b[>4;2m");
    expect(state.modifyOtherKeys).toBe(2);
    await write("\x1bc");
    expect(state.modifyOtherKeys).toBe(0);
  });
});

describe("pane key encoding", () => {
  it.each([
    ["\x1b[32u", " "],
    ["\x1b[32;5u", "\x00"],
    ["\x1b[97;2u", "A"],
    ["\x1b[97;4u", "\x1bA"],
    ["\x1b[127;5u", "\x08"],
    ["\x1b[63;5u", "\x7f"],
  ])("forwards %j as legacy terminal input", (raw, expected) => {
    expect(paneKeyBytes(decodeKey(raw))).toBe(expected);
  });

  it("passes kitty keys to kitty apps and re-encodes them for legacy apps", () => {
    const ctrlC = decodeKey("\x1b[99;5u");
    expect(ctrlC).toMatchObject({ name: "c", ctrl: true });
    expect(paneKeyBytes(ctrlC, { kittyKeyboard: 0 })).toBe("\x03");
    expect(paneKeyBytes(ctrlC, { kittyKeyboard: 1 })).toBe("\x1b[99;5u");
    expect(paneKeyBytes(decodeKey("\x1b[27u"))).toBe("\x1b");
    expect(paneKeyBytes(decodeKey("\x1b[120;3u"))).toBe("\x1bx");
    expect(paneKeyBytes(decodeKey("\x1b[13;2u"))).toBe("\r");
    expect(paneKeyBytes(decodeKey("\x1b[13;2u"), { kittyKeyboard: 3 })).toBe("\x1b[13;2u");
    // Legacy input from the host is forwarded unchanged.
    expect(paneKeyBytes(decodeKey("\x1b[A"), { kittyKeyboard: 1 })).toBe("\x1b[A");
    expect(paneKeyBytes(decodeKey("q"))).toBe("q");
  });
});
