/** Single-line text field with readline/emacs editing, as in Shepherd's text
 * fields (rename prompts, filters, search). */

export interface TextField {
  value: string;
  /** Cursor position in code points. */
  cursor: number;
  /** Last killed text, for ctrl+y. */
  kill: string;
}

export interface EditKey {
  name: string;
  ctrl: boolean;
  alt: boolean;
  text: string;
}

export function textField(value = ""): TextField {
  return { value, cursor: [...value].length, kill: "" };
}

const isWordChar = (character: string | undefined) =>
  character !== undefined && /[\p{L}\p{N}_]/u.test(character);

function wordStartBefore(chars: string[], cursor: number): number {
  let index = cursor;
  while (index > 0 && !isWordChar(chars[index - 1])) index -= 1;
  while (index > 0 && isWordChar(chars[index - 1])) index -= 1;
  return index;
}

function wordEndAfter(chars: string[], cursor: number): number {
  let index = cursor;
  while (index < chars.length && !isWordChar(chars[index])) index += 1;
  while (index < chars.length && isWordChar(chars[index])) index += 1;
  return index;
}

/** Applies an editing key. Returns null when the key is not an edit (for
 * example Enter or Escape), so the caller can handle it. */
export function editText(
  field: TextField,
  key: EditKey,
  maxLength = 500,
): TextField | null {
  const chars = [...field.value];
  const cursor = Math.max(0, Math.min(chars.length, field.cursor));
  const make = (next: string[], position: number, kill = field.kill): TextField => ({
    value: next.join(""),
    cursor: Math.max(0, Math.min(next.length, position)),
    kill,
  });
  const killRange = (from: number, to: number): TextField => make(
    [...chars.slice(0, from), ...chars.slice(to)],
    from,
    chars.slice(from, to).join(""),
  );

  if (key.ctrl && !key.alt) {
    switch (key.name) {
      case "a": return make(chars, 0);
      case "e": return make(chars, chars.length);
      case "b": return make(chars, cursor - 1);
      case "f": return make(chars, cursor + 1);
      case "h":
      case "backspace":
        return key.name === "backspace"
          ? killRange(wordStartBefore(chars, cursor), cursor)
          : cursor > 0 ? make([...chars.slice(0, cursor - 1), ...chars.slice(cursor)], cursor - 1) : field;
      case "d": return make([...chars.slice(0, cursor), ...chars.slice(cursor + 1)], cursor);
      case "u": return killRange(0, cursor);
      case "k": return killRange(cursor, chars.length);
      case "w": return killRange(wordStartBefore(chars, cursor), cursor);
      case "y": {
        const inserted = [...field.kill];
        if (chars.length + inserted.length > maxLength) return field;
        return make(
          [...chars.slice(0, cursor), ...inserted, ...chars.slice(cursor)],
          cursor + inserted.length,
        );
      }
      default: return null;
    }
  }
  if (key.alt) {
    switch (key.name) {
      case "b": return make(chars, wordStartBefore(chars, cursor));
      case "f": return make(chars, wordEndAfter(chars, cursor));
      case "d": return killRange(cursor, wordEndAfter(chars, cursor));
      case "backspace": return killRange(wordStartBefore(chars, cursor), cursor);
      default: return null;
    }
  }
  switch (key.name) {
    case "left": return make(chars, cursor - 1);
    case "right": return make(chars, cursor + 1);
    case "home": return make(chars, 0);
    case "end": return make(chars, chars.length);
    case "backspace":
      return cursor > 0
        ? make([...chars.slice(0, cursor - 1), ...chars.slice(cursor)], cursor - 1)
        : field;
    case "delete": return make([...chars.slice(0, cursor), ...chars.slice(cursor + 1)], cursor);
    default:
      break;
  }
  if (key.text && !/[\x00-\x1f\x7f]/.test(key.text)) {
    return insertText(field, key.text, maxLength);
  }
  return null;
}

export function insertText(field: TextField, text: string, maxLength = 500): TextField {
  const chars = [...field.value];
  const cursor = Math.max(0, Math.min(chars.length, field.cursor));
  const inserted = [...text.replace(/[\x00-\x1f\x7f]/g, "")]
    .slice(0, Math.max(0, maxLength - chars.length));
  return {
    value: [...chars.slice(0, cursor), ...inserted, ...chars.slice(cursor)].join(""),
    cursor: cursor + inserted.length,
    kill: field.kill,
  };
}

/** Splits a field for rendering with a cursor. */
export function fieldParts(field: TextField): [string, string, string] {
  const chars = [...field.value];
  const cursor = Math.max(0, Math.min(chars.length, field.cursor));
  return [
    chars.slice(0, cursor).join(""),
    chars[cursor] ?? " ",
    chars.slice(cursor + 1).join(""),
  ];
}
