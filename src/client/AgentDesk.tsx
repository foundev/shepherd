import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { Box, Text } from "ink";
import { ageLabel, DESK_FILTERS, deskEntries, filterDesk, LANE_LABELS, type DeskEntry, type DeskFilter, type DeskLane } from "../agentDesk.js";
import type { AgentTaskPatch, ShepherdRequest, StateView, TaskChanges, TerminalLine } from "../types.js";
import type { AppConnection } from "./App.js";
import type { InputToken } from "./input.js";
import { editText, fieldParts, insertText, textField, type TextField } from "./textEditor.js";
import { truncateText } from "./chrome.js";
import { theme } from "./theme.js";
import { displayWidth } from "./geometry.js";

export interface AgentDeskHandle { input(token: InputToken): void }
interface Editor {
  entry: DeskEntry;
  kind: "task" | "prompt";
  fields: TextField[];
  selected: number;
  revision: number;
}
const FIELDS = ["title", "summary", "nextAction", "blocker", "checkStatus", "checkSummary"] as const;
const LABELS = ["Task", "Progress / result", "Next action", "Blocker", "Checks", "Check details"];
const LIMITS = [160, 2000, 1000, 1000, 12, 1000];
const CHECKS = ["unknown", "running", "passed", "failed"];
const VIEWS = ["brief", "context", "changes", "output", "history"] as const;
type DetailView = typeof VIEWS[number];
const laneColor = (lane: DeskLane) => lane === "blocked" ? theme.danger : lane === "review" ? theme.cyan : lane === "working" ? theme.warning : lane === "ready" ? theme.success : theme.muted;
const safeText = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

/** Stateful React master/detail view. Only visible cards and one output preview render. */
export function AgentDesk({ state, connection, columns, rows, onClose, onOpen, refresh, ref }: {
  state: StateView; connection: AppConnection; columns: number; rows: number;
  onClose(): void; onOpen(entry: DeskEntry): Promise<void>; refresh(): Promise<void>;
  ref?: Ref<AgentDeskHandle>;
}) {
  const [filter, setFilter] = useState<DeskFilter>("attention");
  const [query, setQuery] = useState(textField());
  const [searching, setSearching] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState(false);
  const [view, setView] = useState<DetailView>("brief");
  const [detailOffset, setDetailOffset] = useState(0);
  const [changes, setChanges] = useState<{ key: string; value: TaskChanges | null; error?: string } | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [preview, setPreview] = useState<{ key: string; lines: string[]; error?: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const entries = useMemo(() => deskEntries(state), [state]);
  const items = useMemo(() => filterDesk(entries, filter, query.value), [entries, filter, query.value]);
  const selected = items.find(entry => entry.key === selectedKey) ?? items[0];
  const selectedIndex = selected ? items.indexOf(selected) : 0;
  const wide = columns >= 100;
  const bodyHeight = Math.max(6, rows - 6);
  const listWidth = wide ? Math.min(58, Math.floor(columns * .42)) : columns;
  const capacity = Math.max(1, Math.floor((bodyHeight - 3) / 4));
  const offset = Math.max(0, Math.min(selectedIndex - Math.floor(capacity / 2), items.length - capacity));
  const visible = items.slice(offset, offset + capacity);
  const lastClick = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    if (selected && selected.key !== selectedKey) setSelectedKey(selected.key);
  }, [selected?.key, selectedKey]);
  useEffect(() => setDetailOffset(0), [selected?.key, view]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  async function request(entry: DeskEntry, message: ShepherdRequest) {
    if (!entry.online) throw new Error("Machine is disconnected. This is cached context; reconnect before acting.");
    return connection.request(entry.machineId
      ? { type: "machine.request", labelOrId: entry.machineId, request: message }
      : message);
  }

  // A single sequential poll; obsolete responses never populate another agent's preview.
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const entry = selected;
    if (!entry) { setPreview(null); return; }
    const poll = async () => {
      try {
        const result = await request(entry, { type: "pane.snapshot", paneId: entry.pane.id, rows: 30, source: "recent-unwrapped" }) as { lines: TerminalLine[] };
        if (!disposed) setPreview({ key: entry.key, lines: result.lines.map(line => safeText(line.map(span => span.text).join(""))).filter(line => line.trim()) });
      } catch (error) {
        if (!disposed) setPreview({ key: entry.key, lines: [], error: error instanceof Error ? error.message : String(error) });
      }
      if (!disposed) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [selected?.key, selected?.online, connection]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const entry = selected;
    if (view !== "changes" || !entry) return;
    const poll = async () => {
      try {
        const value = await request(entry, { type: "task.changes", paneId: entry.pane.id }) as TaskChanges | null;
        if (!disposed) setChanges({ key: entry.key, value });
      } catch (error) {
        if (!disposed) setChanges({ key: entry.key, value: null, error: error instanceof Error ? error.message : String(error) });
      }
      if (!disposed) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [selected?.key, selected?.online, connection, view]);

  const refreshEntry = async (entry: DeskEntry) => {
    if (entry.machineId) await connection.request({ type: "machine.refresh", labelOrId: entry.machineId });
    await refresh();
  };

  const act = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setNotice("");
    try { await work(); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const move = (delta: number) => {
    const next = items[Math.max(0, Math.min(items.length - 1, selectedIndex + delta))];
    if (next) setSelectedKey(next.key);
  };
  const chooseFilter = (next: DeskFilter) => { setFilter(next); setSelectedKey(null); setNotice(""); };
  const open = () => selected && void act(async () => {
    if (!selected.online) throw new Error("Reconnect this machine before opening its workspace.");
    await onOpen(selected);
  });
  const edit = (kind: Editor["kind"]) => {
    if (!selected) return;
    if (!selected.online) { setNotice("Reconnect this machine before editing."); return; }
    setEditor({ entry: selected, kind, fields: kind === "prompt" ? [textField()]
      : FIELDS.map(field => textField(selected.pane.task?.[field] ?? (field === "checkStatus" ? "unknown" : ""))),
    selected: 0, revision: selected.pane.task?.revision ?? 0 });
    setNotice("");
  };
  const save = () => editor && void act(async () => {
    if (editor.kind === "prompt") {
      await request(editor.entry, { type: "agent.send", paneId: editor.entry.pane.id, text: editor.fields[0]!.value });
      setNotice("Instruction sent. Waiting for the agent's next status signal.");
    } else {
      const patch = Object.fromEntries(FIELDS.map((field, i) => [field, editor.fields[i]!.value])
        .filter(([field, value]) => value !== (editor.entry.pane.task?.[field as keyof AgentTaskPatch] ?? (field === "checkStatus" ? "unknown" : "")))) as AgentTaskPatch;
      if (!Object.keys(patch).length) { setEditor(null); setNotice("No changes to save."); return; }
      await request(editor.entry, { type: "task.update", paneId: editor.entry.pane.id, patch, expectedRevision: editor.revision });
      setNotice("Task context saved.");
    }
    setEditor(null);
    await refreshEntry(editor.entry);
  });
  const review = () => selected && void act(async () => {
    if (selected.lane !== "review") throw new Error("Select an item awaiting review first.");
    await request(selected, { type: "task.update", paneId: selected.pane.id, patch: { review: "reviewed" }, expectedRevision: selected.pane.task?.revision ?? 0 });
    setNotice("Review acknowledged. Check results remain as reported.");
    await refreshEntry(selected);
  });
  const cycleView = () => { setView(VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]!); setDetail(true); };
  const buttons = [
    { label: columns < 80 ? "↵ open" : "Enter open", run: open },
    { label: "t task", run: () => edit("task") },
    { label: "p prompt", run: () => edit("prompt") },
    { label: "r review", run: review },
    ...(columns >= 80 ? [{ label: "v views", run: cycleView }] : []),
  ];
  const filterLabels = DESK_FILTERS.map((name, i) => ` ${i + 1} ${columns < 80 && name === "attention" ? "needs" : name} `);
  const changeField = (field: TextField) => {
    if (editor) setEditor({ ...editor, fields: editor.fields.map((value, i) => i === editor.selected ? field : value) });
  };

  useImperativeHandle(ref, () => ({ input(token) {
    if (busyRef.current) return;
    if (token.kind === "paste") {
      const text = safeText(token.text);
      if (editor) changeField(insertText(editor.fields[editor.selected]!, text, editor.kind === "prompt" ? 8000 : LIMITS[editor.selected]!));
      else if (searching) setQuery(insertText(query, text, 200));
      return;
    }
    if (token.kind === "mouse") {
      if (editor || searching) return;
      const event = token.event;
      if (event.action === "wheel") { move(event.direction === "up" ? -1 : 1); return; }
      if (event.action !== "press" || event.button !== "left") return;
      const x = event.column - 1, y = event.row - 1;
      if (y === rows - 3) {
        let left = 1;
        for (const button of buttons) {
          const right = left + displayWidth(button.label);
          if (x >= left && x < right) { button.run(); return; }
          left = right + 3;
        }
      }
      if (y === 2 && !query.value) {
        let left = 1;
        for (const [index, label] of filterLabels.entries()) {
          const right = left + displayWidth(label);
          if (x >= left && x < right) { chooseFilter(DESK_FILTERS[index]!); return; }
          left = right;
        }
      }
      if ((!detail || wide) && x < listWidth && y >= 5 && y < 5 + visible.length * 4) {
        const entry = visible[Math.floor((y - 5) / 4)];
        if (entry) {
          setSelectedKey(entry.key);
          if (lastClick.current?.key === entry.key && Date.now() - lastClick.current.at < 350) setDetail(true);
          lastClick.current = { key: entry.key, at: Date.now() };
        }
      }
      return;
    }
    if (token.kind !== "key") return;
    const key = token.key;
    if (editor) {
      if (key.name === "escape") { setEditor(null); return; }
      if (key.ctrl && key.name === "s") { save(); return; }
      if (key.name === "enter") {
        if (editor.selected === editor.fields.length - 1) save();
        else setEditor({ ...editor, selected: editor.selected + 1 });
        return;
      }
      if (["tab", "up", "down"].includes(key.name)) {
        const delta = key.name === "up" || key.shift ? -1 : 1;
        setEditor({ ...editor, selected: (editor.selected + delta + editor.fields.length) % editor.fields.length }); return;
      }
      if (editor.kind === "task" && editor.selected === 4) {
        if (["left", "right", "space"].includes(key.name)) {
          const i = CHECKS.indexOf(editor.fields[4]!.value);
          changeField(textField(CHECKS[(i + (key.name === "left" ? 3 : 1)) % 4]!));
        }
      } else {
        const next = editText(editor.fields[editor.selected]!, key, editor.kind === "prompt" ? 8000 : LIMITS[editor.selected]!);
        if (next) changeField(next);
      }
      return;
    }
    if (searching) {
      if (["escape", "enter"].includes(key.name)) setSearching(false);
      else { const next = editText(query, key, 200); if (next) setQuery(next); }
      return;
    }
    if (key.name === "escape") { if (detail && !wide) setDetail(false); else onClose(); }
    else if (key.name === "down" || key.text === "j") move(1);
    else if (key.name === "up" || key.text === "k") move(-1);
    else if (key.name === "pagedown") { if (detail) setDetailOffset(value => value + Math.max(1, bodyHeight - 4)); else move(capacity); }
    else if (key.name === "pageup") { if (detail) setDetailOffset(value => Math.max(0, value - Math.max(1, bodyHeight - 4))); else move(-capacity); }
    else if (key.name === "home") move(-items.length);
    else if (key.name === "end") move(items.length);
    else if (key.name === "tab") setDetail(!detail);
    else if (key.text === "/") setSearching(true);
    else if (key.text === "0") { setQuery(textField()); chooseFilter("attention"); }
    else if (/^[1-7]$/.test(key.text)) chooseFilter(DESK_FILTERS[Number(key.text) - 1]!);
    else if (key.text === "v") cycleView();
    else if (key.name === "enter") open();
    else if (key.text === "t") edit("task");
    else if (key.text === "p") edit("prompt");
    else if (key.text === "r") review();
  } }));

  const counts = (lane: DeskLane) => entries.filter(entry => entry.lane === lane).length;
  const attention = counts("blocked") + counts("review") + counts("unknown");
  const line = (text: string, color = theme.text, bold = false) => <Text wrap="truncate-end" color={color} bold={bold}>{safeText(text)}</Text>;
  return <Box width={columns} height={rows} flexDirection="column" backgroundColor={theme.panelBg}>
    <Box height={1} paddingX={1} justifyContent="space-between">
      <Text color={theme.brand} bold wrap="truncate-end">{columns < 70 ? "◆ AGENT DESK" : <>◆ SHEPHERD <Text color={theme.text}> / AGENT DESK</Text></>}</Text>
      <Text color={attention ? theme.warning : theme.success} bold wrap="truncate-end">{attention} {columns < 70 ? "need you" : "need attention"}</Text>
    </Box>
    <Box height={1} paddingX={1}>{line(columns < 70 ? `${entries.length} agents · ${counts("working")} working · ${counts("review")} review` : `${entries.length} agents & tasks  ·  ${counts("working")} working  ·  ${counts("review")} to review  ·  ${counts("unknown")} uncertain`, theme.muted)}</Box>
    <Box height={1} paddingX={1}>
      {searching || query.value ? line(`/ ${query.value}${searching ? "█" : ""}   · ${filter}`, theme.brand)
        : <Text wrap="truncate-end">{DESK_FILTERS.map((name, i) => <Text key={name} color={name === filter ? theme.panelContrast : theme.muted} backgroundColor={name === filter ? theme.brand : undefined}>{filterLabels[i]}</Text>)}</Text>}
    </Box>
    {editor ? <TaskEditor editor={editor} height={bodyHeight} columns={columns} />
      : <Box height={bodyHeight} flexDirection="row">
        {(wide || !detail) && <Box width={listWidth} height={bodyHeight} borderStyle="round" borderColor={theme.border} flexDirection="column">
          <Box paddingX={1} height={1}>{line(`${filter.toUpperCase()}   ${items.length} results${query.value ? ` · ${query.value}` : ""}`, theme.muted)}</Box>
          {visible.map(entry => <Box key={entry.key} height={4} flexShrink={0} flexDirection="column" paddingX={1} backgroundColor={entry.key === selected?.key ? theme.activeRow : undefined}>
            <Box justifyContent="space-between" height={1}><Text color={laneColor(entry.lane)} bold>{entry.key === selected?.key ? "▸" : " "} {LANE_LABELS[entry.lane]}</Text><Text color={theme.muted}>{ageLabel(entry.since, now)}</Text></Box>
            {line(entry.pane.task?.title || entry.pane.metadataTitle || entry.pane.title || `${entry.pane.agent ?? "Agent"} · add task context`, theme.text, true)}
            {line(`${entry.machineId ? `${entry.machineLabel} / ` : ""}${entry.workspaceLabel} · ${entry.pane.agent ?? "session ended"} · ${entry.pane.id}`, theme.muted)}
          </Box>)}
          {!items.length && <Box paddingX={1} flexDirection="column">
            {line(entries.length ? "Nothing in this view." : "Your agent desk is ready.", theme.text, true)}
            {line(entries.length ? "2 all · / search · 0 reset" : "Launch agents in your workspace panes.", theme.muted)}
          </Box>}
          <Box flexGrow={1} />
          <Box paddingX={1} height={1}>{line(items.length ? `${selectedIndex + 1} / ${items.length}  · ↑↓ choose${wide ? "" : " · Tab inspect"}` : "", theme.muted)}</Box>
        </Box>}
        {(wide || detail) && <Inspector entry={selected} width={wide ? columns - listWidth : columns} height={bodyHeight} view={view} preview={selected?.key === preview?.key ? preview : null} now={now} offset={detailOffset} onOffset={setDetailOffset} changes={selected?.key === changes?.key ? changes : null} />}
      </Box>}
    <Box height={3} flexDirection="column" paddingX={1}>
      {line(editor ? "Tab field · Enter next · Ctrl+S save · Esc cancel" : buttons.map(button => button.label).join(" · "), theme.brand)}
      {line(editor?.kind === "task" ? "Checks: ←/→ choose · Review is separate." : detail ? "PgUp/PgDn scroll · Tab list · Esc back" : columns < 80 ? "v views · / find · Tab detail · Esc back" : "1 attention · 2 all · / search · Tab inspect · Esc back", theme.muted)}
      {line(busy ? "Saving…" : notice || (selected && !selected.online ? "Disconnected machine · cached information" : "Review stays pending until you acknowledge it."), notice ? theme.warning : theme.muted)}
    </Box>
  </Box>;
}

function TaskEditor({ editor, height, columns }: { editor: Editor; height: number; columns: number }) {
  const field = editor.fields[editor.selected]!;
  const [before, cursor, after] = fieldParts(field);
  const budget = Math.max(4, columns - 8);
  return <Box height={height} borderStyle="round" borderColor={theme.brand} paddingX={2} flexDirection="column">
    <Text bold color={theme.brand}>{editor.kind === "task" ? "TASK CONTEXT" : "SEND INSTRUCTION"} · {editor.entry.pane.agent ?? "terminal"} / {editor.entry.pane.id}</Text>
    <Text color={theme.muted} wrap="truncate-end">{editor.entry.workspaceLabel} · {editor.entry.machineLabel}</Text>
    <Box height={1} />
    <Text bold color={theme.text}>{editor.kind === "task" ? `${editor.selected + 1} / ${FIELDS.length}  ${LABELS[editor.selected]}` : "New instruction for this agent"}</Text>
    <Text wrap="truncate-end"><Text color={theme.text}>{truncateText([...before].slice(-Math.floor(budget / 2)).join(""), Math.floor(budget / 2))}</Text><Text inverse>{cursor || " "}</Text><Text color={theme.text}>{after}</Text></Text>
    <Box height={1} />
    <Text wrap="truncate-end" color={theme.muted}>{editor.kind === "task" ? editor.selected === 4 ? "Unknown → running → passed → failed. Include the check command and result in check details." : "Keep enough context here for someone returning to this task." : "Idle agents only. Open a blocked agent's terminal to answer its approval prompt."}</Text>
    <Box flexGrow={1} />
    <Text color={theme.muted}>Ctrl+S save · Esc cancel</Text>
  </Box>;
}

function Inspector({ entry, width, height, view, preview, now, offset, onOffset, changes }: {
  entry?: DeskEntry; width: number; height: number; view: DetailView;
  preview: { lines: string[]; error?: string } | null; now: number; offset: number;
  onOffset(value: number): void;
  changes: { value: TaskChanges | null; error?: string } | null;
}) {
  const lines: Array<{ text: string; color?: string; bold?: boolean }> = [];
  const add = (text: string, color = theme.text, bold = false) => lines.push({ text: safeText(text), color, bold });
  const paragraph = (text: string, color = theme.text) => {
    let line = "";
    for (const character of safeText(text)) {
      if (displayWidth(line + character) > Math.max(1, width - 4)) { add(line, color); line = ""; }
      line += character;
    }
    if (line) add(line, color);
  };
  if (entry) {
    const { pane } = entry, task = pane.task;
    add(`${LANE_LABELS[entry.lane]}  /  ${view.toUpperCase()}`, laneColor(entry.lane), true);
    add(task?.title || pane.title || "Task context not set · press t", theme.text, true);
    add(`${entry.workspaceLabel} · ${entry.workspace?.git?.branch ?? "no branch"} · ${entry.tabLabel}`, theme.muted);
    if (view === "context") {
      for (const [label, value] of [["TASK", task?.title], ["PROGRESS / RESULT", task?.summary], ["NEXT ACTION", task?.nextAction], ["BLOCKER", task?.blocker], ["CHECKS", `${task?.checkStatus ?? "unknown"} · ${task?.checkSummary || "No result reported"}`]]) {
        add(label!, theme.brand, true); paragraph(value || "Not reported");
      }
      add("STATUS EVIDENCE", theme.brand, true);
      paragraph(pane.signal?.reason || "No evidence available");
      add(`Observed ${ageLabel(pane.signal?.observedAt ?? 0, now)} ago · ${pane.signal?.confidence ?? "unknown"}`, theme.muted);
    } else if (view === "brief") {
      add(entry.online ? `${pane.signal?.confidence ?? "unknown"} · ${pane.signal?.reason ?? "Status evidence unavailable"}` : "DISCONNECTED · showing cached context", theme.warning);
      if (pane.continuity === "restarted" || pane.continuity === "resuming") add(pane.continuity === "restarted" ? "Session restarted · previous process did not survive" : "Session resume was requested · verify in output", theme.warning);
      add(`PROGRESS  ${task?.summary || "No progress summary reported"}`);
      add(`NEXT      ${task?.nextAction || (entry.lane === "review" ? "Inspect the result, then press r to acknowledge" : entry.lane === "blocked" ? "Open the terminal to resolve the blocker" : entry.lane === "unknown" ? "Inspect output to establish current state" : "No next action recorded")}`, theme.cyan);
      if (task?.blocker) add(`BLOCKER   ${task.blocker}`, theme.danger);
      add(`CHECKS    ${task?.checkStatus ?? "unknown"}${task?.checkSummary ? ` · ${task.checkSummary}` : " · no result reported"}`, task?.checkStatus === "failed" ? theme.danger : task?.checkStatus === "passed" ? theme.success : theme.muted);
      if (task?.review === "reviewed") add("Review acknowledged", theme.success);
      if (task) add(`Context: ${task.source} · ${ageLabel(task.updatedAt, now)} ago`, theme.muted);
    }
    if (view === "changes") {
      add("CHECKOUT CHANGES", theme.brand, true);
      add("Shared checkout · changes may come from other agents", theme.muted);
      if (!changes) add("Loading changes…", theme.muted);
      else if (changes.error) paragraph(changes.error, theme.warning);
      else if (!changes.value) add("This pane is outside a Git checkout.", theme.muted);
      else {
        add(`${changes.value.total} changed files · index / worktree status`, theme.muted);
        for (const file of changes.value.files) paragraph(`${file.status} ${file.from ? `${file.from} → ` : ""}${file.path}`);
        if (changes.value.total > changes.value.files.length) add(`Showing first ${changes.value.files.length} files`, theme.warning);
        if (!changes.value.total) add("Working tree is clean", theme.success);
      }
    } else if (view === "history") {
      add("REPORTED ACTIVITY", theme.brand, true);
      for (const event of [...(task?.activity ?? [])].reverse()) add(`${ageLabel(event.at, now)} · ${event.text} · ${event.source}`);
      if (!task?.activity.length) add("No task activity reported yet.", theme.muted);
    } else if (view !== "context") {
      add("─ RECENT OUTPUT  ·  v changes view ─", theme.brand);
      const remaining = view === "output" ? 30 : Math.max(1, height - 3 - lines.length);
      if (preview?.error) add(preview.error, theme.warning);
      else if (!preview) add("Loading output…", theme.muted);
      else if (!preview.lines.length) add("No output yet", theme.muted);
      else for (const text of preview.lines.slice(-remaining)) add(text, theme.subtext);
    }
  } else {
    add("Select an agent to inspect its task and output.", theme.muted);
  }
  const pageSize = Math.max(1, height - 3);
  const start = Math.max(0, Math.min(offset, lines.length - pageSize));
  useEffect(() => { if (start !== offset) onOffset(start); }, [start, offset, onOffset]);
  return <Box width={width} height={height} borderStyle="round" borderColor={entry ? laneColor(entry.lane) : theme.border} paddingX={1} flexDirection="column">
    {lines.slice(start, start + pageSize).map((line, i) => <Text key={i} color={line.color} bold={line.bold} wrap="truncate-end">{truncateText(line.text, Math.max(1, width - 4)) || " "}</Text>)}
    <Box flexGrow={1} />
    <Text color={theme.muted} wrap="truncate-end">{view} · v next view{lines.length > pageSize ? ` · ${start + 1}–${Math.min(lines.length, start + pageSize)} / ${lines.length}` : ""}</Text>
  </Box>;
}
