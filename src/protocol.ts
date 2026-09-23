import type { WireMessage } from "./types.js";

export function encodeMessage(message: WireMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeStream(buffer: string): {
  messages: WireMessage[];
  remainder: string;
} {
  const messages: WireMessage[] = [];
  let start = 0;
  while (start < buffer.length) {
    const newline = buffer.indexOf("\n", start);
    if (newline === -1) break;
    const line = buffer.slice(start, newline).trim();
    if (line) {
      try {
        messages.push(JSON.parse(line) as WireMessage);
      } catch {
        // Ignore malformed transport frames. The protocol remains useful even
        // if one attached client emits a partial or corrupt JSON line.
      }
    }
    start = newline + 1;
  }
  return { messages, remainder: buffer.slice(start) };
}
