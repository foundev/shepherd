/** Agent views (agent.view.set): a filter and sort applied to the
 * sidebar's agents list. Shared by the daemon (validation) and the client
 * (evaluation). */
import type { AgentStatus, AgentViewSpec } from "./types.js";

const BUILTIN_FIELDS = ["status", "workspace_id", "tab_id", "pane_id", "agent", "seen", "state_change_seq"];
const BUILTIN_SORTS = [
  "workspace_order",
  "tab_order",
  "pane_order",
  "attention",
  "status",
  "agent",
  "seen",
  "state_change_seq",
];
const STATUSES = ["idle", "working", "blocked", "done", "unknown"];
const TOKEN = /^[A-Za-z0-9_-]{1,32}$/;

type Json = Record<string, unknown>;
type Field = string | { token: string };
type Value = string | boolean | number | { context: "current_workspace_id" | "current_tab_id" };

export class AgentViewError extends Error {}

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateField(field: unknown, sort = false): Field {
  if (typeof field === "string") {
    if (!(sort ? BUILTIN_SORTS : BUILTIN_FIELDS).includes(field)) {
      throw new AgentViewError(`unknown agent view field \`${field}\``);
    }
    return field;
  }
  if (isObject(field) && typeof field.token === "string") {
    if (!TOKEN.test(field.token)) throw new AgentViewError(`invalid agent view token \`${field.token}\``);
    return { token: field.token };
  }
  throw new AgentViewError("agent view field must be a built-in name or { token }");
}

function validateValue(field: Field, value: unknown): void {
  if (isObject(value)) {
    if (
      (field === "workspace_id" && value.context === "current_workspace_id") ||
      (field === "tab_id" && value.context === "current_tab_id")
    ) {
      return;
    }
    throw new AgentViewError("agent view context type does not match the selected field");
  }
  if (field === "seen" ? typeof value === "boolean"
    : field === "state_change_seq" ? typeof value === "number" && Number.isInteger(value) && value >= 0
    : typeof value === "string") {
    if (field === "status" && !STATUSES.includes(value as string)) {
      throw new AgentViewError(`unknown agent status \`${String(value)}\``);
    }
    return;
  }
  throw new AgentViewError("agent view value type does not match the selected field");
}

function validateFilter(filter: unknown, depth: number, nodes: { count: number }): void {
  if (depth > 8) throw new AgentViewError("agent view filter may be nested at most 8 levels");
  nodes.count += 1;
  if (nodes.count > 64) throw new AgentViewError("agent view filter may contain at most 64 nodes");
  if (!isObject(filter)) throw new AgentViewError("agent view filter must be an object");
  switch (filter.op) {
    case "all":
    case "any":
      if (!Array.isArray(filter.filters) || filter.filters.length === 0) {
        throw new AgentViewError("agent view all/any filters must not be empty");
      }
      for (const child of filter.filters) validateFilter(child, depth + 1, nodes);
      return;
    case "not":
      validateFilter(filter.filter, depth + 1, nodes);
      return;
    case "eq": {
      const field = validateField(filter.field);
      validateValue(field, filter.value);
      return;
    }
    case "in": {
      const field = validateField(filter.field);
      if (!Array.isArray(filter.values) || filter.values.length === 0 || filter.values.length > 32) {
        throw new AgentViewError("agent view in filters require 1 to 32 values");
      }
      for (const value of filter.values) validateValue(field, value);
      return;
    }
    case "exists":
      validateField(filter.field);
      return;
    default:
      throw new AgentViewError(`unknown agent view filter op \`${String(filter.op)}\``);
  }
}

/** Validates and normalizes agent.view.set params. */
export function validateAgentView(
  params: Json,
  normalizeId: (id: string) => string = (id) => id,
): AgentViewSpec {
  const source = normalizeAgentViewSource(params.source);
  let label: string | null = null;
  if (params.label !== undefined && params.label !== null) {
    if (typeof params.label !== "string") throw new AgentViewError("agent view label must be a string");
    label = params.label.trim().replace(/[\x00-\x1f\x7f]/g, "");
    if (!label || [...label].length > 32) {
      throw new AgentViewError("agent view label must be non-empty and at most 32 characters");
    }
  }
  const filter = params.filter ?? null;
  if (filter !== null) {
    validateFilter(filter, 1, { count: 0 });
    normalizeIds(filter as Json, normalizeId);
  }
  const rawSort = params.sort ?? [];
  if (!Array.isArray(rawSort)) throw new AgentViewError("agent view sort must be an array");
  if (rawSort.length > 8) throw new AgentViewError("agent view sort may contain at most 8 fields");
  const sort = rawSort.map((entry) => {
    if (!isObject(entry)) throw new AgentViewError("agent view sort entries must be objects");
    const order = entry.order ?? "asc";
    if (order !== "asc" && order !== "desc") throw new AgentViewError("sort order must be asc or desc");
    return { field: validateField(entry.field, true) as unknown, order: order as "asc" | "desc" };
  });
  return { source, label, filter, sort };
}

const ID_FIELDS = ["workspace_id", "tab_id", "pane_id"];

function normalizeIds(filter: Json, normalizeId: (id: string) => string): void {
  if (Array.isArray(filter.filters)) {
    for (const child of filter.filters) normalizeIds(child as Json, normalizeId);
  }
  if (isObject(filter.filter)) normalizeIds(filter.filter, normalizeId);
  if (typeof filter.field !== "string" || !ID_FIELDS.includes(filter.field)) return;
  if (typeof filter.value === "string") filter.value = normalizeId(filter.value);
  if (Array.isArray(filter.values)) {
    filter.values = filter.values.map((value) => typeof value === "string" ? normalizeId(value) : value);
  }
}

export function normalizeAgentViewSource(raw: unknown): string {
  const source = typeof raw === "string" ? raw.trim() : "";
  if (!source || source.length > 120 || !/^[A-Za-z0-9:._-]+$/.test(source)) {
    throw new AgentViewError(
      "agent view source must be non-empty, at most 120 characters, and contain only ASCII letters, digits, colon, dot, underscore, or hyphen",
    );
  }
  return source;
}

/** What a view can see of one agent entry. */
export interface AgentViewEntry {
  status: AgentStatus;
  workspaceId: string;
  tabId: string;
  paneId: string;
  agent: string | null;
  seen: boolean;
  stateChangeSeq: number | null;
  tokens: Record<string, string>;
  workspaceOrder: number;
  tabOrder: number;
  paneOrder: number;
}

export interface AgentViewContext {
  workspaceId: string | null;
  tabId: string | null;
}

const ATTENTION: Record<AgentStatus, number> = { blocked: 4, done: 3, working: 2, idle: 1, unknown: 0 };

function fieldValue(entry: AgentViewEntry, field: Field): string | number | boolean | null {
  if (typeof field !== "string") return entry.tokens[field.token] ?? null;
  switch (field) {
    case "status": return entry.status;
    case "workspace_id": return entry.workspaceId;
    case "tab_id": return entry.tabId;
    case "pane_id": return entry.paneId;
    case "agent": return entry.agent;
    case "seen": return entry.seen;
    case "state_change_seq": return entry.stateChangeSeq;
    case "workspace_order": return entry.workspaceOrder;
    case "tab_order": return entry.tabOrder;
    case "pane_order": return entry.paneOrder;
    case "attention": return ATTENTION[entry.status];
    default: return null;
  }
}

function operand(context: AgentViewContext, value: Value): string | number | boolean | null {
  if (typeof value === "object") {
    return value.context === "current_workspace_id" ? context.workspaceId : context.tabId;
  }
  return value;
}

export function matchesFilter(
  context: AgentViewContext,
  entry: AgentViewEntry,
  filter: unknown,
): boolean {
  const node = filter as Json;
  switch (node.op) {
    case "all": return (node.filters as unknown[]).every((child) => matchesFilter(context, entry, child));
    case "any": return (node.filters as unknown[]).some((child) => matchesFilter(context, entry, child));
    case "not": return !matchesFilter(context, entry, node.filter);
    case "eq": {
      const actual = fieldValue(entry, node.field as Field);
      return actual !== null && actual === operand(context, node.value as Value);
    }
    case "in": {
      const actual = fieldValue(entry, node.field as Field);
      return actual !== null &&
        (node.values as Value[]).some((value) => actual === operand(context, value));
    }
    case "exists": return fieldValue(entry, node.field as Field) !== null;
    default: return false;
  }
}

function compareValues(left: string | number | boolean, right: string | number | boolean): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Filters and sorts entries by a view; missing sort values go last. */
export function applyAgentView<T>(
  view: AgentViewSpec,
  context: AgentViewContext,
  entries: T[],
  describe: (entry: T) => AgentViewEntry,
): T[] {
  let result = entries;
  if (view.filter) result = result.filter((entry) => matchesFilter(context, describe(entry), view.filter));
  if (view.sort.length === 0) return result;
  const described = new Map(result.map((entry) => [entry, describe(entry)]));
  return [...result].sort((left, right) => {
    for (const sort of view.sort) {
      const a = fieldValue(described.get(left)!, sort.field as Field);
      const b = fieldValue(described.get(right)!, sort.field as Field);
      if (a === null && b === null) continue;
      if (a === null) return 1;
      if (b === null) return -1;
      const ordering = compareValues(a, b);
      if (ordering !== 0) return sort.order === "desc" ? -ordering : ordering;
    }
    return 0;
  });
}
