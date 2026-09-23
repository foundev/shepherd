import { describe, expect, it } from "vitest";
import { editText, textField, type TextField } from "../src/client/textEditor.js";
import { decodeKey } from "../src/client/input.js";

function type(field: TextField, ...raws: string[]): TextField {
  let current = field;
  for (const raw of raws) {
    current = editText(current, decodeKey(raw)) ?? current;
  }
  return current;
}

describe("text fields", () => {
  it("inserts at the cursor and moves with emacs keys", () => {
    let field = type(textField(), "w", "o", "r", "l", "d");
    field = type(field, "\x01", "h", "e", "l", "l", "o", " ");
    expect(field.value).toBe("hello world");
    expect(field.cursor).toBe(6);
    field = type(field, "\x05", "\x02", "\x02", "\x04");
    expect(field.value).toBe("hello word");
  });

  it("kills and yanks words and line ends", () => {
    let field = textField("git commit --amend");
    field = type(field, "\x17");
    expect(field.value).toBe("git commit --");
    field = type(field, "\x19");
    expect(field.value).toBe("git commit --amend");
    field = type(field, "\x1bb", "\x1bb", "\x0b");
    expect(field.value).toBe("git ");
    field = type(field, "\x15");
    expect(field.value).toBe("");
    expect(field.kill).toBe("git ");
  });

  it("leaves enter and escape to the caller", () => {
    expect(editText(textField("x"), decodeKey("\r"))).toBeNull();
    expect(editText(textField("x"), decodeKey("\x1b"))).toBeNull();
  });
});
