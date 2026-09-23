import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clipboardCommand,
  writeClipboardText,
} from "../src/server/clipboard.js";

const temporaryDirectories: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("clipboard", () => {
  it("uses a platform clipboard command", () => {
    const command = clipboardCommand();
    if (process.platform === "darwin") {
      expect(command.file).toBe("pbcopy");
    } else if (process.platform === "win32") {
      expect(command.file).toBe("powershell.exe");
    } else {
      expect(command.file).toBe("sh");
    }
  });

  it("writes stdin to the selected clipboard command", async () => {
    if (process.platform !== "darwin") return;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-clip-"));
    temporaryDirectories.push(directory);
    const output = path.join(directory, "clipboard.txt");
    const bin = path.join(directory, "bin");
    fs.mkdirSync(bin, { recursive: true });
    const fakePbcopy = path.join(bin, "pbcopy");
    fs.writeFileSync(
      fakePbcopy,
      `#!/bin/sh\ncat > ${JSON.stringify(output)}\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

    await writeClipboardText("selected\nterminal\ntext\n");
    expect(fs.readFileSync(output, "utf8")).toBe(
      "selected\nterminal\ntext\n",
    );
  });
});
