// Drives the real attached UI inside a PTY and prints the rendered screen.
// Usage: node scripts/e2e-drive.mjs '<json array of steps>'
// A step is {"send": "..."} or {"wait": ms} or {"screen": true}.
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pty from "node-pty";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless");

const steps = JSON.parse(process.argv[2] ?? "[]");
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-e2e-"));
const socket = path.join(stateRoot, "daemon.sock");
const cols = 140;
const rows = 40;
const terminal = new Terminal({ cols, rows, allowProposedApi: true });
const env = {
  ...process.env,
  SHEPHERD_STATE_HOME: stateRoot,
  SHEPHERD_SOCKET_PATH: socket,
  SHELL: "/bin/bash",
  PS1: "$ ",
  BASH_SILENCE_DEPRECATION_WARNING: "1",
  // Copies go to OSC 52 instead of the real clipboard.
  SSH_TTY: "/dev/null",
};
const child = pty.spawn(process.execPath, ["bin/shepherd", "--socket", socket], {
  name: "xterm-256color",
  cols,
  rows,
  cwd: process.cwd(),
  env,
});
child.onData((data) => terminal.write(data));

function screen() {
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let y = 0; y < rows; y += 1) {
    lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await sleep(2500);
for (const step of steps) {
  if (step.send !== undefined) child.write(step.send);
  if (step.cli) {
    const run = pty.spawn(process.execPath, ["bin/shepherd", "--socket", socket, ...step.cli], { env });
    await new Promise((resolve) => run.onExit(resolve));
  }
  if (step.wait) await sleep(step.wait);
  if (step.screen) console.log(`----- screen (cursor ${terminal.buffer.active.cursorX},${terminal.buffer.active.cursorY}) -----\n${screen()}\n------------------`);
}
child.write("\x02q");
await sleep(300);
child.kill();
// Stop the daemon started for this run.
const stop = pty.spawn(process.execPath, ["bin/shepherd", "--socket", socket, "server", "stop"], { env });
await new Promise((resolve) => stop.onExit(resolve));
fs.rmSync(stateRoot, { recursive: true, force: true });
process.exit(0);
