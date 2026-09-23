import { useEffect, useRef } from "react";
import { useStdin, useStdout } from "ink";
import type { EventEmitter } from "node:events";
import { classifyMouse, type MouseInputEvent } from "./mouse.js";
import { writeHost } from "./screenWriter.js";

/** A decoded key press. `raw` is exactly what the host terminal sent, so it
 * can be forwarded to a pane without loss. */
export interface KeyPress {
  raw: string;
  /** Lower-case key name: a printable character, or enter, escape, tab,
   * backspace, space, up, down, left, right, home, end, pageup, pagedown,
   * insert, delete, f1..f12. */
  name: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Printable text carried by the key, if any. */
  text: string;
}

export type InputToken =
  | { kind: "key"; key: KeyPress }
  | { kind: "paste"; text: string }
  | { kind: "mouse"; event: MouseInputEvent }
  | { kind: "focus"; focused: boolean }
  /** The host terminal's colour scheme: explicit (CSI ?997) or inferred
   * from its background colour (OSC 11). */
  | { kind: "appearance"; appearance: "dark" | "light"; explicit: boolean };

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/** Turns Ink's raw input events (already split into escape sequences and
 * text runs) into keys, pastes, mouse and focus events. */
export class InputDecoder {
  private paste: string | null = null;
  /** Body of an OSC reply from the host terminal, which Ink delivers as
   * `ESC ]`, the text, and `BEL` or `ESC \`. */
  private osc: string | null = null;

  push(event: string): InputToken[] {
    if (this.osc !== null) {
      if (event === "\x1b\\") return this.finishOsc();
      if (this.osc === "" && !/^\d+;/.test(event)) {
        // Not an OSC reply after all: a real Alt+] key press.
        this.osc = null;
        return [{ kind: "key", key: decodeKey("\x1b]") }, ...this.push(event)];
      }
      const bell = event.indexOf("\x07");
      if (bell === -1) {
        this.osc += event;
        if (this.osc.length > 4096) this.osc = null;
        return [];
      }
      this.osc += event.slice(0, bell);
      const rest = event.slice(bell + 1);
      return [...this.finishOsc(), ...(rest ? this.push(rest) : [])];
    }
    if (event === "\x1b]" && this.paste === null) {
      this.osc = "";
      return [];
    }
    if (this.paste !== null) {
      const end = event.indexOf(PASTE_END);
      if (end === -1) {
        this.paste += event;
        return [];
      }
      const text = this.paste + event.slice(0, end);
      this.paste = null;
      const rest = event.slice(end + PASTE_END.length);
      return [{ kind: "paste", text }, ...(rest ? this.push(rest) : [])];
    }

    const start = event.indexOf(PASTE_START);
    if (start !== -1) {
      const before = event.slice(0, start);
      this.paste = "";
      return [
        ...(before ? this.push(before) : []),
        ...this.push(event.slice(start + PASTE_START.length)),
      ];
    }

    if (event === "\x1b[?997;1n") return [{ kind: "appearance", appearance: "dark", explicit: true }];
    if (event === "\x1b[?997;2n") return [{ kind: "appearance", appearance: "light", explicit: true }];
    if (event === "\x1b[I") return [{ kind: "focus", focused: true }];
    if (event === "\x1b[O") return [{ kind: "focus", focused: false }];

    const mouse = SGR_MOUSE.exec(event);
    if (mouse) {
      return [{
        kind: "mouse",
        event: classifyMouse(
          Number.parseInt(mouse[1] ?? "0", 10),
          mouse[4] === "m",
          Number.parseInt(mouse[2] ?? "1", 10),
          Number.parseInt(mouse[3] ?? "1", 10),
        ),
      }];
    }

    if (event.startsWith("\x1b")) {
      return [{ kind: "key", key: decodeKey(event) }];
    }

    // A text run may contain control characters typed quickly between
    // printable characters; split so each control is its own key.
    const tokens: InputToken[] = [];
    for (const character of event) {
      tokens.push({ kind: "key", key: decodeKey(character) });
    }
    return tokens;
  }

  private finishOsc(): InputToken[] {
    const body = this.osc ?? "";
    this.osc = null;
    const background = /^11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)$/i.exec(body);
    if (!background) return [];
    const [r, g, b] = background.slice(1, 4).map((hex) =>
      Math.round(Number.parseInt(hex!, 16) / (16 ** hex!.length - 1) * 255)
    );
    const luminance = r! * 299 + g! * 587 + b! * 114;
    return [{ kind: "appearance", appearance: luminance >= 128_000 ? "light" : "dark", explicit: false }];
  }

  get pasting(): boolean {
    return this.paste !== null;
  }
}

const TILDE_KEYS: Record<string, string> = {
  "1": "home",
  "2": "insert",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
  "7": "home",
  "8": "end",
  "11": "f1",
  "12": "f2",
  "13": "f3",
  "14": "f4",
  "15": "f5",
  "17": "f6",
  "18": "f7",
  "19": "f8",
  "20": "f9",
  "21": "f10",
  "23": "f11",
  "24": "f12",
};

const LETTER_KEYS: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
};

const KITTY_KEYS: Record<number, string> = {
  9: "tab",
  13: "enter",
  27: "escape",
  32: "space",
  127: "backspace",
};

export function decodeKey(raw: string): KeyPress {
  const key = (
    name: string,
    modifiers: Partial<Pick<KeyPress, "ctrl" | "alt" | "shift">> = {},
    text = "",
  ): KeyPress => ({
    raw,
    name,
    ctrl: modifiers.ctrl ?? false,
    alt: modifiers.alt ?? false,
    shift: modifiers.shift ?? false,
    text,
  });

  if (raw === "\r" || raw === "\n") return key("enter");
  if (raw === "\t") return key("tab");
  if (raw === "\x7f" || raw === "\b") return key("backspace");
  if (raw === "\x1b") return key("escape");
  if (raw === "\x00") return key("space", { ctrl: true });
  if (raw === " ") return key("space", {}, " ");

  if (raw.length === 1) {
    const code = raw.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      return key(String.fromCharCode(code + 96), { ctrl: true });
    }
    if (code >= 28 && code <= 31) {
      return key(String.fromCharCode(code + 64), { ctrl: true });
    }
  }

  const csi = /^\x1b\[([0-9;:]*)([A-Za-z~])$/.exec(raw);
  if (csi) {
    const params = (csi[1] ?? "").split(";");
    const final = csi[2] ?? "";
    const modifiers = modifierFlags(params[1]);
    if (final === "Z") return key("tab", { ...modifiers, shift: true });
    if (final === "~") {
      const name = TILDE_KEYS[params[0] ?? ""];
      if (name) return key(name, modifiers);
    }
    if (final === "u") {
      const code = Number.parseInt((params[0] ?? "").split(":")[0] ?? "", 10);
      const name = KITTY_KEYS[code] ?? String.fromCodePoint(code).toLowerCase();
      return key(name, modifiers);
    }
    const letter = LETTER_KEYS[final];
    if (letter) return key(letter, modifiers);
    return key(raw);
  }

  const ss3 = /^\x1bO([A-Z])$/.exec(raw);
  if (ss3) {
    const name = LETTER_KEYS[ss3[1] ?? ""];
    if (name) return key(name);
  }

  if (raw.startsWith("\x1b") && raw.length > 1) {
    const inner = decodeKey(raw.slice(1));
    return { ...inner, raw, alt: true };
  }

  const lower = raw.toLowerCase();
  const shift = raw !== lower && raw.length === 1;
  return key(shift ? lower : raw, { shift }, raw);
}

/** Bytes to send a pane for a key press. Keys the host reported in kitty
 * CSI u form pass through to apps that enabled the kitty protocol and are
 * re-encoded as legacy xterm bytes for everything else. */
export function paneKeyBytes(
  press: KeyPress,
  modes?: { applicationCursorKeys?: boolean; kittyKeyboard?: number },
): string {
  if (!/^\x1b\[[0-9:;]*u$/.test(press.raw)) return press.raw;
  if (((modes?.kittyKeyboard ?? 0) & 1) !== 0) return press.raw;
  const modifier = 1 + Number(press.shift) + 2 * Number(press.alt) + 4 * Number(press.ctrl);
  const cursor: Record<string, string> = {
    up: "A", down: "B", right: "C", left: "D", home: "H", end: "F",
  };
  const final = cursor[press.name];
  if (final) {
    if (modifier > 1) return `\x1b[1;${modifier}${final}`;
    return modes?.applicationCursorKeys ? `\x1bO${final}` : `\x1b[${final}`;
  }
  const tilde: Record<string, number> = {
    insert: 2, delete: 3, pageup: 5, pagedown: 6,
    f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24,
  };
  const code = tilde[press.name];
  if (code) return modifier > 1 ? `\x1b[${code};${modifier}~` : `\x1b[${code}~`;
  if (/^f[1-4]$/.test(press.name)) {
    const letter = "PQRS"[Number(press.name.slice(1)) - 1];
    return modifier > 1 ? `\x1b[1;${modifier}${letter}` : `\x1bO${letter}`;
  }
  let plain = press.name === "enter" ? "\r"
    : press.name === "tab" ? (press.shift ? "\x1b[Z" : "\t")
    : press.name === "backspace" ? (press.ctrl ? "\x08" : "\x7f")
    : press.name === "escape" ? "\x1b"
    : press.name === "space" ? " "
    : press.text || press.name;
  if (press.shift && /^[a-z]$/.test(plain)) plain = plain.toUpperCase();
  if (press.ctrl && plain.length === 1) {
    const aliases: Record<string, string> = {
      " ": "\x00", "2": "\x00", "3": "\x1b", "4": "\x1c",
      "5": "\x1d", "6": "\x1e", "7": "\x1f", "8": "\x7f", "?": "\x7f",
    };
    if (aliases[plain] !== undefined) plain = aliases[plain];
    else {
      const key = plain.toUpperCase().charCodeAt(0);
      if (key >= 64 && key <= 95) plain = String.fromCharCode(key - 64);
    }
  }
  return press.alt ? `\x1b${plain}` : plain;
}

function modifierFlags(value: string | undefined): Pick<
  KeyPress,
  "ctrl" | "alt" | "shift"
> {
  const encoded = Number.parseInt((value ?? "").split(":")[0] ?? "", 10);
  const bits = Number.isFinite(encoded) && encoded > 1 ? encoded - 1 : 0;
  return {
    shift: (bits & 1) !== 0,
    alt: (bits & 2) !== 0,
    ctrl: (bits & 4) !== 0,
  };
}

/** Ink-style `(input, key)` view of a key press, for text fields and
 * pickers that only need simple editing keys. */
export interface InkStyleKey {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageUp: boolean;
  pageDown: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
}

export function inkStyle(key: KeyPress): { input: string; key: InkStyleKey } {
  return {
    input: key.text || (key.ctrl && key.name.length === 1 ? key.name : ""),
    key: {
      upArrow: key.name === "up",
      downArrow: key.name === "down",
      leftArrow: key.name === "left",
      rightArrow: key.name === "right",
      pageUp: key.name === "pageup",
      pageDown: key.name === "pagedown",
      return: key.name === "enter",
      escape: key.name === "escape",
      ctrl: key.ctrl,
      shift: key.shift,
      tab: key.name === "tab",
      backspace: key.name === "backspace",
      delete: key.name === "delete",
      meta: key.alt,
    },
  };
}

// Kitty keyboard flag 1 (disambiguate): the host sends Esc and modified
// keys as unambiguous CSI u sequences; terminals without it ignore this.
const HOST_MODES_ON = "\x1b[?2004h\x1b[?1004h\x1b[>1u";
const APPEARANCE_ON = "\x1b[?2031h";
const APPEARANCE_OFF = "\x1b[?2031l";
export const APPEARANCE_QUERY = "\x1b[?996n\x1b]11;?\x1b\\";
const HOST_MODES_OFF = "\x1b[<u\x1b[?1004l\x1b[?2004l";
const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

/** Subscribes to every input event Ink reads from stdin and enables mouse,
 * bracketed-paste and focus reporting on the host terminal. */
export function useTerminalInput(
  handler: (token: InputToken) => void,
  captureMouse = true,
  trackAppearance = false,
): void {
  const stdinContext = useStdin() as ReturnType<typeof useStdin> & {
    internal_eventEmitter?: EventEmitter;
  };
  const { setRawMode, internal_eventEmitter: emitter } = stdinContext;
  const { stdout } = useStdout();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!emitter) return;
    setRawMode(true);
    writeHost(stdout, HOST_MODES_ON);
    const decoder = new InputDecoder();
    const onInput = (event: string) => {
      for (const token of decoder.push(event)) handlerRef.current(token);
    };
    emitter.on("input", onInput);
    return () => {
      emitter.removeListener("input", onInput);
      writeHost(stdout, HOST_MODES_OFF);
      setRawMode(false);
    };
  }, [emitter, setRawMode, stdout]);

  // With theme.auto_switch, ask for colour-scheme change reports (mode
  // 2031), the current scheme, and the background colour as a fallback.
  useEffect(() => {
    if (!trackAppearance) return;
    writeHost(stdout, APPEARANCE_ON + APPEARANCE_QUERY);
    return () => writeHost(stdout, APPEARANCE_OFF);
  }, [trackAppearance, stdout]);

  // Mouse reporting is on while Shepherd captures the mouse; otherwise the
  // host terminal keeps normal clicks (for example Cmd-clicking URLs).
  useEffect(() => {
    if (!captureMouse) return;
    writeHost(stdout, MOUSE_ON);
    return () => writeHost(stdout, MOUSE_OFF);
  }, [captureMouse, stdout]);
}
