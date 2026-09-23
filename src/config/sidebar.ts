/** `[ui.sidebar.agents]` and `[ui.sidebar.spaces]`: which tokens each
 * sidebar entry shows, row by row, with optional styles and rules. */
import { AGENTS } from "../server/detection/agents.js";

export const AGENT_TOKENS = [
  "state_icon",
  "state_text",
  "machine",
  "workspace",
  "tab",
  "pane",
  "agent",
  "terminal_title",
  "terminal_title_stripped",
] as const;
export const SPACE_TOKENS = [
  "state_icon",
  "state_text",
  "workspace",
  "branch",
  "git_status",
] as const;

export interface TokenStyle {
  fg?: string;
  bold?: boolean;
  dim?: boolean;
}

export interface TokenRule extends TokenStyle {
  equals?: string;
  contains?: string;
  starts_with?: string;
  gt?: number;
  lt?: number;
  ignore_case?: boolean;
  hide?: boolean;
}

/** A built-in token name, or `$name` for a reported metadata token. */
export interface SidebarToken {
  token: string;
  style: TokenStyle;
  rules: TokenRule[];
}

export type SidebarRows = SidebarToken[][];

export interface SidebarConfig {
  agents: { rows: SidebarRows; rows_by_agent: Record<string, SidebarRows>; row_gap: number };
  spaces: { rows: SidebarRows; row_gap: number };
}

const plain = (token: string): SidebarToken => ({ token, style: {}, rules: [] });

export function defaultSidebarConfig(): SidebarConfig {
  return {
    agents: {
      rows: [
        ["state_icon", "machine", "workspace", "tab"].map(plain),
        [plain("agent")],
      ],
      rows_by_agent: {},
      row_gap: 0,
    },
    spaces: {
      rows: [["state_icon", "workspace"].map(plain), ["branch", "git_status"].map(plain)],
      row_gap: 0,
    },
  };
}

const CUSTOM = /^\$[A-Za-z0-9_-]{1,32}$/;
const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function parseStyle(table: Record<string, unknown>, where: string): TokenStyle {
  const style: TokenStyle = {};
  if (table.fg !== undefined) {
    if (typeof table.fg !== "string" || !COLOR.test(table.fg)) {
      throw new Error(`${where}: fg must be #RGB or #RRGGBB`);
    }
    style.fg = table.fg.length === 4
      ? `#${[...table.fg.slice(1)].map((digit) => digit + digit).join("")}`
      : table.fg;
  }
  for (const key of ["bold", "dim"] as const) {
    if (table[key] === undefined) continue;
    if (typeof table[key] !== "boolean") throw new Error(`${where}: ${key} must be a boolean`);
    style[key] = table[key] as boolean;
  }
  return style;
}

function parseRule(raw: unknown, where: string): TokenRule {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${where}: rules must be tables`);
  }
  const table = raw as Record<string, unknown>;
  const conditions = ["equals", "contains", "starts_with", "gt", "lt"].filter((key) =>
    table[key] !== undefined
  );
  if (conditions.length !== 1) {
    throw new Error(`${where}: a rule needs exactly one of equals, contains, starts_with, gt, lt`);
  }
  const rule: TokenRule = parseStyle(table, where);
  const [condition] = conditions;
  if (condition === "gt" || condition === "lt") {
    if (typeof table[condition] !== "number" || !Number.isFinite(table[condition])) {
      throw new Error(`${where}: ${condition} must be a finite number`);
    }
    if (table.ignore_case !== undefined) {
      throw new Error(`${where}: ignore_case applies to text conditions only`);
    }
    rule[condition] = table[condition] as number;
  } else {
    if (typeof table[condition!] !== "string") {
      throw new Error(`${where}: ${condition} must be a string`);
    }
    (rule as Record<string, unknown>)[condition!] = table[condition!];
    if (table.ignore_case !== undefined) {
      if (typeof table.ignore_case !== "boolean") {
        throw new Error(`${where}: ignore_case must be a boolean`);
      }
      rule.ignore_case = table.ignore_case;
    }
  }
  if (table.hide !== undefined) {
    if (typeof table.hide !== "boolean") throw new Error(`${where}: hide must be a boolean`);
    rule.hide = table.hide;
  }
  return rule;
}

function parseToken(raw: unknown, builtins: readonly string[], where: string): SidebarToken {
  const table = typeof raw === "string"
    ? { token: raw }
    : raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : null;
  if (!table || typeof table.token !== "string") {
    throw new Error(`${where}: tokens must be strings or { token = ... } tables`);
  }
  const name = table.token;
  if (!builtins.includes(name) && !CUSTOM.test(name)) {
    throw new Error(
      name.startsWith("$")
        ? `${where}: invalid custom sidebar token \`${name}\``
        : `${where}: unknown sidebar token \`${name}\`; custom tokens must start with \`$\``,
    );
  }
  for (const key of Object.keys(table)) {
    if (!["token", "fg", "bold", "dim", "rules"].includes(key)) {
      throw new Error(`${where}: unknown field ${key}`);
    }
  }
  const rawRules = table.rules ?? [];
  if (!Array.isArray(rawRules)) throw new Error(`${where}: rules must be an array`);
  if (rawRules.length > 16) throw new Error(`${where}: sidebar tokens may contain at most 16 rules`);
  if (rawRules.length > 0 && (name === "state_icon" || name === "git_status")) {
    throw new Error(`${where}: sidebar rules require a text-valued token`);
  }
  return {
    token: name,
    style: parseStyle(table, where),
    rules: rawRules.map((rule, index) => parseRule(rule, `${where}.rules[${index}]`)),
  };
}

function parseRows(raw: unknown, builtins: readonly string[], where: string): SidebarRows {
  if (!Array.isArray(raw) || raw.some((row) => !Array.isArray(row))) {
    throw new Error(`${where}: expected a list of token rows`);
  }
  if (raw.length > 16) throw new Error(`${where}: sidebar layouts may contain at most 16 rows`);
  return (raw as unknown[][]).map((row, rowIndex) => {
    if (row.length > 16) throw new Error(`${where}: sidebar rows may contain at most 16 tokens`);
    return row.map((token, index) => parseToken(token, builtins, `${where}[${rowIndex}][${index}]`));
  });
}

function rowGap(raw: unknown, where: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 65_535) {
    throw new Error(`${where}: expected a non-negative integer`);
  }
  return raw;
}

/** Reads `[ui.sidebar]`. An invalid section keeps its defaults and adds a
 * diagnostic. */
export function parseSidebarConfig(raw: unknown, diagnostics: string[]): SidebarConfig {
  const config = defaultSidebarConfig();
  if (raw === undefined) return config;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    diagnostics.push("ui.sidebar: expected a table");
    return config;
  }
  const table = raw as Record<string, unknown>;
  const agents = table.agents as Record<string, unknown> | undefined;
  if (agents !== undefined) {
    try {
      if (typeof agents !== "object" || Array.isArray(agents)) throw new Error("ui.sidebar.agents: expected a table");
      const rows = agents.rows === undefined
        ? config.agents.rows
        : parseRows(agents.rows, AGENT_TOKENS, "ui.sidebar.agents.rows");
      const byAgent: Record<string, SidebarRows> = {};
      const rawByAgent = agents.rows_by_agent ?? {};
      if (typeof rawByAgent !== "object" || Array.isArray(rawByAgent)) {
        throw new Error("ui.sidebar.agents.rows_by_agent: expected a table");
      }
      for (const [id, value] of Object.entries(rawByAgent as Record<string, unknown>)) {
        if (!AGENTS.some((agent) => agent.id === id)) {
          throw new Error(`ui.sidebar.agents.rows_by_agent: unknown canonical agent id \`${id}\``);
        }
        byAgent[id] = parseRows(value, AGENT_TOKENS, `ui.sidebar.agents.rows_by_agent.${id}`);
      }
      config.agents = {
        rows,
        rows_by_agent: byAgent,
        row_gap: rowGap(agents.row_gap, "ui.sidebar.agents.row_gap", 0),
      };
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
  }
  const spaces = table.spaces as Record<string, unknown> | undefined;
  if (spaces !== undefined) {
    try {
      if (typeof spaces !== "object" || Array.isArray(spaces)) throw new Error("ui.sidebar.spaces: expected a table");
      config.spaces = {
        rows: spaces.rows === undefined
          ? config.spaces.rows
          : parseRows(spaces.rows, SPACE_TOKENS, "ui.sidebar.spaces.rows"),
        row_gap: rowGap(spaces.row_gap, "ui.sidebar.spaces.row_gap", 0),
      };
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
  }
  return config;
}

function ruleMatches(rule: TokenRule, value: string): boolean {
  const fold = (text: string) =>
    rule.ignore_case ? text.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) : text;
  if (rule.equals !== undefined) return fold(value) === fold(rule.equals);
  if (rule.starts_with !== undefined) return fold(value).startsWith(fold(rule.starts_with));
  if (rule.contains !== undefined) return fold(value).includes(fold(rule.contains));
  const number = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(number)) return false;
  if (rule.gt !== undefined) return number > rule.gt;
  if (rule.lt !== undefined) return number < rule.lt;
  return false;
}

/** The style for a token's value: the first matching rule overrides the
 * base style; null when that rule hides the token. */
export function styleForValue(token: SidebarToken, value: string): TokenStyle | null {
  for (const rule of token.rules) {
    if (!ruleMatches(rule, value)) continue;
    if (rule.hide) return null;
    return {
      fg: rule.fg ?? token.style.fg,
      bold: rule.bold ?? token.style.bold,
      dim: rule.dim ?? token.style.dim,
    };
  }
  return token.style;
}
