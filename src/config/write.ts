import fs from "node:fs";
import path from "node:path";

/** Formats a TOML value for a string, boolean or number. */
function tomlValue(value: string | boolean | number): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** Sets `key` in `[section]` of TOML text, keeping everything else
 * (comments, ordering) intact. Adds the key or section when missing. */
export function setTomlValue(
  text: string,
  section: string,
  key: string,
  value: string | boolean | number,
): string {
  const lines = text.split("\n");
  const header = `[${section}]`;
  const line = `${key} = ${tomlValue(value)}`;
  const start = lines.findIndex((entry) => entry.trim() === header);
  if (start === -1) {
    const trimmed = text.replace(/\s*$/, "");
    return `${trimmed}${trimmed ? "\n\n" : ""}${header}\n${line}\n`;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  const keyPattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
  for (let index = start + 1; index < end; index += 1) {
    if (keyPattern.test(lines[index] ?? "")) {
      lines[index] = line;
      return lines.join("\n");
    }
  }
  lines.splice(start + 1, 0, line);
  return lines.join("\n");
}

export function writeConfigValue(
  file: string,
  section: string,
  key: string,
  value: string | boolean | number,
): void {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = setTomlValue(text, section, key, value);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, next);
  fs.renameSync(temporary, file);
}
