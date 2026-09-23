import { describe, expect, it } from "vitest";
import { decodeKey, InputDecoder } from "../src/client/input.js";

describe("key decoding", () => {
  it.each([
    ["\x7f", "backspace", {}],
    ["\r", "enter", {}],
    ["\t", "tab", {}],
    ["\x1b[Z", "tab", { shift: true }],
    ["\x1b[H", "home", {}],
    ["\x1b[F", "end", {}],
    ["\x1b[1~", "home", {}],
    ["\x1b[4~", "end", {}],
    ["\x1b[5~", "pageup", {}],
    ["\x1b[6~", "pagedown", {}],
    ["\x1b[3~", "delete", {}],
    ["\x1bOP", "f1", {}],
    ["\x1b[15~", "f5", {}],
    ["\x1b[24~", "f12", {}],
    ["\x1b[1;5A", "up", { ctrl: true }],
    ["\x1b[1;3D", "left", { alt: true }],
    ["\x1b[1;2C", "right", { shift: true }],
    ["\x02", "b", { ctrl: true }],
    ["\x00", "space", { ctrl: true }],
    ["\x1bx", "x", { alt: true }],
    ["P", "p", { shift: true }],
    ["\x1b[98;5u", "b", { ctrl: true }],
  ])("decodes %j as %s", (raw, name, modifiers) => {
    const key = decodeKey(raw);
    expect(key.raw).toBe(raw);
    expect(key.name).toBe(name);
    expect({
      ctrl: key.ctrl,
      alt: key.alt,
      shift: key.shift,
    }).toEqual({ ctrl: false, alt: false, shift: false, ...modifiers });
  });
});

describe("input decoder", () => {
  it("splits control characters out of text runs", () => {
    const tokens = new InputDecoder().push("a\x02b");
    expect(tokens.map((token) =>
      token.kind === "key" ? token.key.name : token.kind
    )).toEqual(["a", "b", "b"]);
    expect(tokens[1]).toMatchObject({ kind: "key", key: { ctrl: true } });
  });

  it("collects bracketed pastes across events", () => {
    const decoder = new InputDecoder();
    expect(decoder.push("\x1b[200~")).toEqual([]);
    expect(decoder.push("line one\r")).toEqual([]);
    expect(decoder.push("line two")).toEqual([]);
    expect(decoder.push("\x1b[201~")).toEqual([
      { kind: "paste", text: "line one\rline two" },
    ]);
    expect(decoder.pasting).toBe(false);
  });

  it("decodes SGR mouse and focus reports", () => {
    const decoder = new InputDecoder();
    expect(decoder.push("\x1b[<0;10;5M")).toMatchObject([
      { kind: "mouse", event: { button: "left", action: "press", column: 10, row: 5 } },
    ]);
    expect(decoder.push("\x1b[<65;3;4M")).toMatchObject([
      { kind: "mouse", event: { action: "wheel", direction: "down" } },
    ]);
    expect(decoder.push("\x1b[I")).toEqual([{ kind: "focus", focused: true }]);
  });
});

describe("host appearance reports", () => {
  it("decodes colour-scheme reports and OSC 11 backgrounds", () => {
    const decoder = new InputDecoder();
    expect(decoder.push("\x1b[?997;2n")).toEqual([{ kind: "appearance", appearance: "light", explicit: true }]);
    expect(decoder.push("\x1b]")).toEqual([]);
    expect(decoder.push("11;rgb:1e1e/1e1e/2e2e")).toEqual([]);
    expect(decoder.push("\x1b\\")).toEqual([{ kind: "appearance", appearance: "dark", explicit: false }]);
    decoder.push("\x1b]");
    expect(decoder.push("11;rgb:ffff/ffff/f0f0\x07x")).toEqual([
      { kind: "appearance", appearance: "light", explicit: false },
      expect.objectContaining({ kind: "key", key: expect.objectContaining({ name: "x" }) }),
    ]);
  });

  it("treats ESC ] followed by text as Alt+]", () => {
    const decoder = new InputDecoder();
    expect(decoder.push("\x1b]")).toEqual([]);
    const tokens = decoder.push("a");
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toMatchObject({ kind: "key", key: { raw: "\x1b]", alt: true } });
    expect(tokens[1]).toMatchObject({ kind: "key", key: { name: "a" } });
  });
});
