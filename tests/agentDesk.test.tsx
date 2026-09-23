import React, { createRef } from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { AgentDesk, type AgentDeskHandle } from "../src/client/AgentDesk.js";
import { deskEntries, filterDesk } from "../src/agentDesk.js";
import { updateTask } from "../src/server/tasks.js";
import { decodeKey } from "../src/client/input.js";
import type { AppConnection } from "../src/client/App.js";
import type { StateView, ShepherdRequest } from "../src/types.js";
import { displayWidth } from "../src/client/geometry.js";

export function fleetState(count = 50): StateView {
  return {
    protocolVersion: 1, serverPid: 1, session: "fleet", stateVersion: 1,
    activeWorkspaceId: "w0", activeTabId: "t0", focusedPaneId: "p0", plugins: [], machines: [], tabs: [],
    panes: Array.from({ length: count }, (_, i) => ({
      id: `p${i}`, title: "", command: "claude", agent: i % 2 ? "codex" : "claude", cwd: `/work/project-${Math.floor(i / 10)}`,
      status: (["blocked", "done", "unknown", "working", "idle"] as const)[i % 5]!, exitCode: null, updatedAt: "2026-09-23T10:00:00Z",
      signal: { source: "screen", confidence: "inferred", reason: "Screen matches approval prompt", observedAt: 1000 + i, expiresAt: null },
      task: updateTask(null, { title: `Task ${i}: improve service ${i}`, summary: `Progress for task ${i}`, nextAction: "Inspect changes", review: i % 5 === 1 ? "requested" : "none" }, "fixture", undefined, 1000 + i),
    })),
    workspaces: Array.from({ length: Math.ceil(count / 10) }, (_, w) => ({
      id: `w${w}`, name: `Project ${w}`, rootPath: `/work/project-${w}`, activeTabId: `t${w * 10}`,
      tabs: Array.from({ length: Math.min(10, count - w * 10) }, (_, i) => ({
        id: `t${w * 10 + i}`, name: `Agent ${i}`, layout: { kind: "pane" as const, paneId: `p${w * 10 + i}` },
      })),
    })),
  };
}

const pause = () => new Promise(resolve => setTimeout(resolve, 35));
describe("agent desk", () => {
  it("prioritizes oldest blockers, pending reviews and uncertainty across workspaces", () => {
    const state = fleetState();
    const entries = deskEntries(state);
    expect(entries.slice(0, 10).every(entry => entry.lane === "blocked")).toBe(true);
    expect(entries.slice(10, 20).every(entry => entry.lane === "review")).toBe(true);
    expect(entries.slice(20, 30).every(entry => entry.lane === "unknown")).toBe(true);
    expect(filterDesk(entries, "attention", "")).toHaveLength(30);
    expect(filterDesk(entries, "all", "service 49 Project 4").map(e => e.pane.id)).toEqual(["p49"]);
    state.panes[1]!.status = "idle"; // Looking at a pane does not acknowledge its task.
    expect(deskEntries(state).find(entry => entry.pane.id === "p1")?.lane).toBe("review");
  });

  it("keeps disconnected remote agents in the uncertainty queue with distinct IDs", () => {
    const state = fleetState(1);
    state.machines = [{ id: "edge", label: "Edge", target: "host", port: 22, enabled: true, reachable: false,
      status: "reconnecting", checkedAt: null, error: "offline", remoteSession: "default",
      remote: { serverPid: 2, protocolVersion: 1, workspaces: 1, tabs: 1, paneCount: 1, workspaceList: state.workspaces,
        activeWorkspaceId: "w0", agents: [], panes: [{ paneId: "p0", title: "Remote task", agent: "claude", status: "working" }] } }];
    const entries = deskEntries(state);
    expect(entries.map(e => e.key)).toEqual(["local:p0", "edge:p0"]);
    expect(entries[1]).toMatchObject({ lane: "unknown", online: false });
  });

  it("renders a bounded viewport for 50 agents and navigates to the last one", async () => {
    const state = fleetState();
    const ref = createRef<AgentDeskHandle>();
    const requests: ShepherdRequest[] = [];
    const connection = { request: async (request: ShepherdRequest) => {
      requests.push(request);
      return { lines: [[{ text: `Output ${(request as { paneId?: string }).paneId}` }]] };
    }, close() {} } as AppConnection;
    const instance = render(<AgentDesk ref={ref} state={state} connection={connection} columns={100} rows={24} refresh={async () => {}} onClose={() => {}} onOpen={async () => {}} />);
    try {
      await pause();
      expect(instance.lastFrame()).toContain("50 agents & tasks");
      expect((instance.lastFrame()?.match(/Task \d+:/g) ?? []).length).toBeLessThan(7);
      ref.current!.input({ kind: "key", key: decodeKey("2") });
      await pause();
      ref.current!.input({ kind: "key", key: decodeKey("\x1b[F") });
      await pause();
      expect(instance.lastFrame()).toContain("Task 49:");
      expect(requests.filter(r => r.type === "pane.snapshot").length).toBeLessThanOrEqual(3);
      expect(instance.lastFrame()?.split("\n").length).toBe(24);
      expect(instance.lastFrame()?.split("\n").every(line => displayWidth(line) <= 100)).toBe(true);
    } finally { instance.unmount(); instance.cleanup(); }
  });

  it("keeps the selected agent stable as another agent changes priority", async () => {
    const state = fleetState(5);
    const ref = createRef<AgentDeskHandle>();
    const requests: ShepherdRequest[] = [];
    const connection = { request: async (request: ShepherdRequest) => { requests.push(request); return { lines: [] }; }, close() {} } as AppConnection;
    const props = { ref, connection, columns: 100, rows: 24, refresh: async () => {}, onClose() {}, onOpen: async () => {} };
    const instance = render(<AgentDesk {...props} state={state} />);
    try {
      await pause();
      ref.current!.input({ kind: "key", key: decodeKey("j") });
      await pause(); // p1, awaiting review.
      const changed = structuredClone(state);
      changed.panes[4]!.status = "blocked";
      instance.rerender(<AgentDesk {...props} state={changed} />);
      await pause();
      ref.current!.input({ kind: "key", key: decodeKey("r") });
      await pause();
      expect(requests.find(r => r.type === "task.update")).toMatchObject({ paneId: "p1", patch: { review: "reviewed" }, expectedRevision: 1 });
    } finally { instance.unmount(); instance.cleanup(); }
  });

  it("edits context and supports a narrow inspector without overflowing", async () => {
    const state = fleetState(1);
    const ref = createRef<AgentDeskHandle>();
    const requests: ShepherdRequest[] = [];
    const connection = { request: async (request: ShepherdRequest) => { requests.push(request); return { lines: [] }; }, close() {} } as AppConnection;
    const instance = render(<AgentDesk ref={ref} state={state} connection={connection} columns={60} rows={24} refresh={async () => {}} onClose={() => {}} onOpen={async () => {}} />);
    try {
      await pause();
      for (const raw of ["t", "\x15"]) { ref.current!.input({ kind: "key", key: decodeKey(raw) }); await pause(); }
      ref.current!.input({ kind: "paste", text: "Fix API retries" }); await pause();
      ref.current!.input({ kind: "key", key: decodeKey("\x13") }); await pause();
      expect(requests.find(r => r.type === "task.update")).toMatchObject({ paneId: "p0", patch: { title: "Fix API retries" }, expectedRevision: 1 });
      ref.current!.input({ kind: "key", key: decodeKey("\t") }); await pause();
      expect(instance.lastFrame()).toContain("PROGRESS");
      expect(instance.lastFrame()?.split("\n").every(line => displayWidth(line) <= 60)).toBe(true);
    } finally { instance.unmount(); instance.cleanup(); }
  });
});
