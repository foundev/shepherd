/** Tracks the keyboard protocol a pane's app asked for: kitty keyboard
 * flags (a push/pop stack, `CSI > flags u`, `CSI = flags u`, `CSI < n u`)
 * and xterm's modifyOtherKeys level (`CSI > 4 ; level m`). The client uses
 * the flags to decide how to encode keys for the pane. */
import type { Terminal } from "@xterm/headless";

type Params = (number | number[])[];

const first = (params: Params, fallback = 0): number => {
  const value = params[0];
  const number = Array.isArray(value) ? value[0] : value;
  return typeof number === "number" && number >= 0 ? number : fallback;
};

export class KittyKeyboardState {
  flags = 0;
  modifyOtherKeys = 0;
  private stack: number[] = [];

  /** Hooks the pane emulator's parser; `reply` answers `CSI ? u` queries. */
  attach(terminal: Terminal, reply: (data: string) => void): void {
    const parser = terminal.parser;
    parser.registerCsiHandler({ prefix: ">", final: "u" }, (params) => {
      this.push(first(params as Params));
      return true;
    });
    parser.registerCsiHandler({ prefix: "=", final: "u" }, (params) => {
      this.flags = first(params as Params) & 0x1f;
      return true;
    });
    parser.registerCsiHandler({ prefix: "<", final: "u" }, (params) => {
      this.pop(Math.max(1, first(params as Params, 1)));
      return true;
    });
    parser.registerCsiHandler({ prefix: "?", final: "u" }, () => {
      reply(`\x1b[?${this.flags}u`);
      return true;
    });
    parser.registerCsiHandler({ prefix: ">", final: "m" }, (params) => {
      const list = params as Params;
      if (list.length === 0) {
        this.modifyOtherKeys = 0;
      } else if (first(list) === 4) {
        const level = list[1];
        this.modifyOtherKeys = Math.min(2, typeof level === "number" ? level : 0);
      }
      return true;
    });
    // RIS resets the protocol along with the rest of the terminal.
    parser.registerEscHandler({ final: "c" }, () => {
      this.reset();
      return false;
    });
  }

  push(flags: number): void {
    // Kitty bounds the stack; drop the oldest entries past that.
    this.stack.push(this.flags);
    if (this.stack.length > 32) this.stack.shift();
    this.flags = flags & 0x1f;
  }

  pop(count: number): void {
    for (let index = 0; index < count; index += 1) this.flags = this.stack.pop() ?? 0;
  }

  reset(): void {
    this.stack = [];
    this.flags = 0;
    this.modifyOtherKeys = 0;
  }

  /** Sequences that recreate this state in a fresh emulator. */
  replay(): string {
    let out = "";
    if (this.stack.length === 0) {
      if (this.flags) out += `\x1b[=${this.flags}u`;
    } else {
      if (this.stack[0]) out += `\x1b[=${this.stack[0]}u`;
      for (const flags of [...this.stack.slice(1), this.flags]) out += `\x1b[>${flags}u`;
    }
    if (this.modifyOtherKeys) out += `\x1b[>4;${this.modifyOtherKeys}m`;
    return out;
  }
}
