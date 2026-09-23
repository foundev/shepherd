/** Render a simulated 50-agent workspace without starting PTYs or contacting services. */
import fs from "node:fs";
import React from "react";
import { render } from "ink-testing-library";
import { AgentDesk } from "../src/client/AgentDesk.js";
import { applyTheme } from "../src/client/theme.js";
import { updateTask } from "../src/server/tasks.js";
import type { AppConnection } from "../src/client/App.js";
import type { ShepherdRequest, StateView } from "../src/types.js";

const argument = (name: string, fallback: string) => process.argv[process.argv.indexOf(name) + 1] && process.argv.includes(name)
  ? process.argv[process.argv.indexOf(name) + 1]! : fallback;
const columns = Number(argument("--columns", "120"));
const rows = Number(argument("--rows", "30"));
if (!Number.isInteger(columns) || columns < 40 || columns > 240 || !Number.isInteger(rows) || rows < 16 || rows > 80) throw new Error("Use 40–240 columns and 16–80 rows");
applyTheme(argument("--theme", "shepherd"));
const objectives = ["Repair payment retry handling", "Review token rotation", "Trace an intermittent timeout", "Build invoice export", "Document cache behavior", "Resolve migration approval", "Review search pagination", "Inspect lost status signal", "Improve mobile navigation", "Prepare release notes"];
const projects = ["Payments", "Identity", "Search", "Mobile", "Platform"];
const now = Date.now();
const state: StateView = {
  session: "demo", protocolVersion: 1, serverPid: 1, stateVersion: 1, focusedPaneId: "p1", activeWorkspaceId: "w0", activeTabId: "t1", plugins: [], machines: [], tabs: [],
  panes: Array.from({ length: 50 }, (_, i) => ({ id: `p${i + 1}`, title: "", command: null, cwd: `/work/${projects[Math.floor(i / 10)]!.toLowerCase()}`,
    agent: ["claude", "codex", "gemini"][i % 3]!, status: (["blocked", "done", "unknown", "working", "idle"] as const)[i % 5]!, exitCode: null,
    updatedAt: new Date(now - i * 15_000).toISOString(), continuity: "live",
    task: updateTask(null, { title: objectives[i % objectives.length]!, summary: "Implementation is ready for inspection; validation is still in progress.",
      nextAction: i % 5 === 0 ? "Inspect the requested command and respond" : "Review the changes and validation output",
      blocker: i % 5 === 0 ? "Permission requested for a repository command" : "", checkStatus: i % 5 === 1 ? "passed" : "unknown",
      checkSummary: i % 5 === 1 ? "npm test · 42 passed (reported by agent)" : "", review: i % 5 === 1 ? "requested" : "none" }, "demo hook", undefined, now - 60_000 - i * 15_000),
    signal: { source: "integration", confidence: "reported", reason: "demo hook reported permission request", observedAt: now - 30_000, changedAt: now - 60_000 - i * 15_000, expiresAt: now + 90_000 },
  })),
  workspaces: projects.map((name, w) => ({ id: `w${w}`, name, rootPath: `/work/${name.toLowerCase()}`, activeTabId: `t${w * 10 + 1}`,
    git: { repoName: name, repoKey: name, repoRoot: `/work/${name}`, checkoutPath: `/work/${name}`, linked: true, branch: `feature/${name.toLowerCase()}`, ahead: 2, behind: 0 },
    tabs: Array.from({ length: 10 }, (_, i) => ({ id: `t${w * 10 + i + 1}`, name: `Agent ${i + 1}`, layout: { kind: "pane" as const, paneId: `p${w * 10 + i + 1}` } })),
  })),
};
const connection = { close() {}, request: async (request: ShepherdRequest) => request.type === "pane.snapshot"
  ? { lines: ["$ npm test", "42 tests passed", "Review the pending repository command", "Approve this command? [y/N]"].map(text => [{ text }]) }
  : {} } as AppConnection;
const instance = render(<AgentDesk state={state} connection={connection} columns={columns} rows={rows} onClose={() => {}} onOpen={async () => {}} refresh={async () => {}} />);
Object.defineProperty(instance.stdout, "columns", { value: columns, configurable: true });
instance.stdout.emit("resize");
await new Promise(resolve => setTimeout(resolve, 100));
const frame = instance.lastFrame() ?? "";
instance.unmount(); instance.cleanup();
const output = argument("--out", "");
if (output) fs.writeFileSync(output, `${frame}\n`);
else process.stdout.write(`${frame}\n`);
