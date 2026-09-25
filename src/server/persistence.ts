import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTask, LayoutNode } from "../types.js";

export interface PersistedPane {
  id: string;
  title: string;
  command: string | null;
  cwd: string;
  task?: AgentTask | null;
  completed?: boolean;
  /** Agent session reported by an integration, for native resume. */
  agentSession?: { source: string; agent: string; value: string } | null;
}

export interface PersistedTab {
  id: string;
  name: string;
  layout: LayoutNode;
  /** Stable directory source, independent of focus and pane swaps. */
  rootPaneId?: string;
  focusedPaneId: string;
  zoomedPaneId?: string | null;
}

export interface PersistedWorkspace {
  id: string;
  name: string;
  rootPath: string;
  tabs: PersistedTab[];
  activeTabId: string;
}

export interface PersistedState {
  version: 2;
  activeWorkspaceId: string;
  workspaces: PersistedWorkspace[];
  panes: PersistedPane[];
}

export interface LegacyPersistedState {
  version: 1;
  activeTabId: string;
  tabs: PersistedTab[];
  panes: PersistedPane[];
}

export function stateDirectory(session: string): string {
  const override = process.env.SHEPHERD_STATE_HOME;
  if (override) return path.join(override, session);
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(home, "AppData", "Local", "shepherd", session);
  }
  return path.join(home, ".local", "state", "shepherd", session);
}

export function statePath(session: string): string {
  return path.join(stateDirectory(session), "state.json");
}

/** Shepherd keeps up to 48 rolling copies, at most one per 15 minutes. */
export const SNAPSHOT_LIMIT = 48;
export const SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;
export const BACKUP_LIMIT = 3;

export function snapshotDirectory(session: string): string {
  return path.join(stateDirectory(session), "session-snapshots");
}

export function backupDirectory(session: string): string {
  return path.join(stateDirectory(session), "session-backups");
}

export function saveState(
  session: string,
  state: PersistedState,
  now = Date.now(),
): void {
  const file = statePath(session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify(state, null, 2)}\n`;
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, text, "utf8");
  fs.renameSync(temporary, file);
  writeRollingSnapshot(session, text, now);
}

function writeRollingSnapshot(session: string, text: string, now: number): void {
  const directory = snapshotDirectory(session);
  try {
    fs.mkdirSync(directory, { recursive: true });
    const existing = listJson(directory);
    const newest = existing[existing.length - 1];
    const newestTime = newest ? Number(/(\d+)\.json$/.exec(newest)?.[1] ?? 0) : 0;
    if (now - newestTime < SNAPSHOT_INTERVAL_MS) return;
    fs.writeFileSync(path.join(directory, `state-${now}.json`), text, "utf8");
    prune(directory, SNAPSHOT_LIMIT);
  } catch {
    // Snapshots are a safety net; a failure must not stop the save.
  }
}

function listJson(directory: string): string[] {
  try {
    return fs.readdirSync(directory)
      .filter((name) => /^state-\d+\.json$/.test(name))
      .sort((left, right) =>
        Number(/(\d+)/.exec(left)?.[1] ?? 0) - Number(/(\d+)/.exec(right)?.[1] ?? 0)
      );
  } catch {
    return [];
  }
}

function prune(directory: string, keep: number): void {
  const files = listJson(directory);
  for (const name of files.slice(0, Math.max(0, files.length - keep))) {
    fs.rmSync(path.join(directory, name), { force: true });
  }
}

function parseState(raw: string): PersistedState | null {
  const parsed = JSON.parse(raw) as PersistedState | LegacyPersistedState;
  if (parsed.version === 1 && Array.isArray(parsed.tabs)) {
    return migrateLegacyState(parsed);
  }
  if (parsed.version !== 2 || !Array.isArray(parsed.workspaces)) return null;
  return parsed;
}

/** Loads the saved session. An unreadable state.json is kept in
 * session-backups/ and the newest rolling snapshot is used instead. */
/** Pane screen history (experimental.pane_history), kept apart from the
 * session because pane output can hold secrets. */
export interface PersistedHistory {
  version: 1;
  /** Fingerprint of the session layout the history belongs to. */
  layoutFingerprint: string;
  /** Pane id → ANSI text of its normal screen and scrollback. */
  panes: Record<string, string>;
}

export function historyPath(session: string): string {
  return path.join(stateDirectory(session), "session-history.json");
}

/** Identifies a saved layout: workspaces, tabs and pane placement. */
export function layoutFingerprint(state: PersistedState): string {
  const shape = state.workspaces.map((workspace) => ({
    id: workspace.id,
    tabs: workspace.tabs.map((tab) => ({ id: tab.id, layout: tab.layout })),
  }));
  return crypto.createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}

export function saveHistory(session: string, history: PersistedHistory): void {
  const file = historyPath(session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(history), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function removeHistory(session: string): void {
  fs.rmSync(historyPath(session), { force: true });
}

/** History saved for exactly this layout, or null. */
export function loadHistory(session: string, state: PersistedState): PersistedHistory | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(historyPath(session), "utf8")) as PersistedHistory;
    if (parsed.version !== 1 || parsed.layoutFingerprint !== layoutFingerprint(state)) return null;
    return parsed.panes && typeof parsed.panes === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function loadState(session: string, now = Date.now()): PersistedState | null {
  const file = statePath(session);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const state = parseState(raw);
    if (state) return state;
  } catch {
    // Fall through to recovery.
  }
  try {
    const backups = backupDirectory(session);
    fs.mkdirSync(backups, { recursive: true });
    fs.copyFileSync(file, path.join(backups, `state-${now}.json`));
    prune(backups, BACKUP_LIMIT);
  } catch {
    // Recovery continues even if the backup cannot be written.
  }
  const snapshots = listJson(snapshotDirectory(session)).reverse();
  for (const name of snapshots) {
    try {
      const state = parseState(
        fs.readFileSync(path.join(snapshotDirectory(session), name), "utf8"),
      );
      if (state) return state;
    } catch {
      // Try the next older snapshot.
    }
  }
  return null;
}

function migrateLegacyState(
  legacy: LegacyPersistedState,
): PersistedState {
  const firstTab = legacy.tabs[0];
  return {
    version: 2,
    activeWorkspaceId: "w1",
      workspaces: [{
        id: "w1",
        name: "main",
        rootPath: legacy.panes[0]?.cwd ?? process.cwd(),
        tabs: legacy.tabs,
      activeTabId: legacy.activeTabId || firstTab?.id || "",
    }],
    panes: legacy.panes,
  };
}
