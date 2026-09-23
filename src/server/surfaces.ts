import type { SurfaceFrame, TerminalLine } from "../types.js";
import type { PaneTerminal } from "./terminal.js";

/** One client's view of one pane: remembers what was last sent so each
 * frame carries only the rows that changed. */
export class SurfaceSubscription {
  readonly paneId: string;
  cols: number;
  rows: number;
  private sentRows: string[] = [];
  private sentMeta = "";
  private sentRevision = -1;
  /** First buffer line shown, or null to follow the live screen. */
  private top: number | null = null;

  constructor(paneId: string, cols: number, rows: number) {
    this.paneId = paneId;
    this.cols = cols;
    this.rows = rows;
  }

  /** Forget everything sent so the next frame is complete. */
  reset(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.sentRows = [];
    this.sentMeta = "";
    this.sentRevision = -1;
  }

  /** Scrolls this client's view; positive moves toward the live screen. */
  scrollBy(lines: number, pane: PaneTerminal): void {
    const base = pane.baseLine;
    const current = this.top ?? base;
    const next = Math.max(0, Math.min(base, current + Math.trunc(lines)));
    this.top = next >= base ? null : next;
    this.sentRevision = -1;
  }

  /** Shows buffer line `top` at the top of the view (null follows live). */
  scrollTo(top: number | null, pane: PaneTerminal): void {
    const base = pane.baseLine;
    const next = top === null ? null : Math.max(0, Math.min(base, Math.floor(top)));
    this.top = next === null || next >= base ? null : next;
    this.sentRevision = -1;
  }

  followLive(): boolean {
    if (this.top === null) return false;
    this.top = null;
    this.sentRevision = -1;
    return true;
  }

  frame(pane: PaneTerminal): SurfaceFrame | null {
    if (pane.revision === this.sentRevision) return null;
    const full = this.sentRows.length === 0;
    const rows = pane.rows;
    const view = pane.view(this.top);
    const lines = view.lines;
    const changed: Record<number, TerminalLine> = {};
    const nextRows: string[] = [];
    for (let index = 0; index < rows; index += 1) {
      const line = lines[index] ?? [];
      const encoded = JSON.stringify(line);
      nextRows.push(encoded);
      if (full || this.sentRows[index] !== encoded) changed[index] = line;
    }
    const { cursor, scroll } = view;
    const modes = pane.modes;
    const meta = JSON.stringify([
      cursor,
      scroll,
      modes,
      pane.terminalTitle,
      pane.cols,
      rows,
    ]);
    this.sentRevision = pane.revision;
    if (!full && Object.keys(changed).length === 0 && meta === this.sentMeta) {
      return null;
    }
    this.sentRows = nextRows;
    this.sentMeta = meta;
    return {
      paneId: pane.id,
      revision: pane.revision,
      cols: pane.cols,
      rows,
      full,
      lines: changed,
      cursor,
      title: pane.terminalTitle,
      scroll,
      modes,
    };
  }
}
