import { spawn } from "node:child_process";

export function clipboardCommand(): { file: string; args: string[] } {
  if (process.platform === "darwin") return { file: "pbcopy", args: [] };
  if (process.platform === "win32") {
    return {
      file: "powershell.exe",
      args: [
        "-NoProfile",
        "-Command",
        "$input | Set-Clipboard",
      ],
    };
  }
  return { file: "sh", args: [
    "-c",
    "if command -v wl-copy >/dev/null 2>&1; then exec wl-copy; elif command -v xclip >/dev/null 2>&1; then exec xclip -selection clipboard; elif command -v xsel >/dev/null 2>&1; then exec xsel --clipboard --input; else exit 127; fi",
  ] };
}

export function writeClipboardText(text: string): Promise<void> {
  const command = clipboardCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      env: process.env,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new Error(
        stderr.trim() ||
          `clipboard command exited ${exitCode ?? "without status"}`,
      ));
    });
    child.stdin?.on("error", reject);
    child.stdin?.end(text);
  });
}
