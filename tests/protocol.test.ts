import { describe, expect, it } from "vitest";
import { decodeStream, encodeMessage } from "../src/protocol.js";

describe("protocol", () => {
  it("round-trips newline-delimited JSON", () => {
    const message = { id: "1", type: "hello" } as const;
    const encoded = encodeMessage(message);
    expect(encoded.endsWith("\n")).toBe(true);
    expect(decodeStream(encoded)).toEqual({
      messages: [message],
      remainder: "",
    });
  });

  it("keeps partial frames buffered", () => {
    expect(decodeStream('{"id":"2"').remainder).toBe('{"id":"2"');
  });
});
