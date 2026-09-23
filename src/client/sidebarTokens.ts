/** Resolves `[ui.sidebar]` token rows against an entry and lays them out
 * in a width budget. */
import { styleForValue, type SidebarRows, type TokenStyle } from "../config/sidebar.js";
import type { Segment } from "./chrome.js";
import { displayWidth } from "./geometry.js";
import { theme } from "./theme.js";

type Kind =
  | "state_icon"
  | "git_status"
  | "state_text"
  | "workspace"
  | "secondary"
  | "custom";

export interface ResolvedToken {
  kind: Kind;
  text: string;
  ahead?: number;
  behind?: number;
  style: TokenStyle;
}

/** Values available to tokens; null leaves the token out. */
export interface TokenValues {
  state_icon: string;
  state_text: string;
  workspace: string;
  machine?: string | null;
  tab?: string | null;
  pane?: string | null;
  agent?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  branch?: string | null;
  git_status?: { ahead: number; behind: number } | null;
  tokens: Record<string, string>;
}

const SECONDARY = new Set([
  "machine",
  "tab",
  "pane",
  "agent",
  "terminal_title",
  "terminal_title_stripped",
  "branch",
]);

/** Rows of resolved tokens; rows with nothing to show are dropped. */
export function resolveRows(rows: SidebarRows, values: TokenValues): ResolvedToken[][] {
  const result: ResolvedToken[][] = [];
  for (const row of rows) {
    const resolved: ResolvedToken[] = [];
    for (const token of row) {
      let kind: Kind;
      let text: string | null | undefined;
      if (token.token === "state_icon") {
        resolved.push({ kind: "state_icon", text: values.state_icon, style: token.style });
        continue;
      }
      if (token.token === "git_status") {
        const git = values.git_status;
        if (git && (git.ahead > 0 || git.behind > 0)) {
          resolved.push({ kind: "git_status", text: "", ...git, style: token.style });
        }
        continue;
      }
      if (token.token.startsWith("$")) {
        kind = "custom";
        text = values.tokens[token.token.slice(1)];
      } else if (token.token === "state_text") {
        kind = "state_text";
        text = values.state_text;
      } else if (token.token === "workspace") {
        kind = "workspace";
        text = values.workspace;
      } else if (SECONDARY.has(token.token)) {
        kind = "secondary";
        text = values[token.token as keyof TokenValues] as string | null | undefined;
      } else {
        continue;
      }
      if (text === null || text === undefined) continue;
      const style = styleForValue(token, text);
      if (!style) continue;
      resolved.push({ kind, text, style });
    }
    if (resolved.length > 0) result.push(resolved);
  }
  return result;
}

function separator(previous: ResolvedToken, current: ResolvedToken): string {
  return previous.kind === "state_icon" || current.kind === "git_status" ? " " : " · ";
}

function gitText(token: ResolvedToken): string {
  const parts: string[] = [];
  if (token.ahead) parts.push(`↑${token.ahead}`);
  if (token.behind) parts.push(`↓${token.behind}`);
  return parts.join(" ");
}

function truncateEnd(text: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  let result = "";
  for (const character of text) {
    if (displayWidth(result + character) > width - 1) break;
    result += character;
  }
  return `${result}…`;
}

type Color = string | undefined;

export interface TokenColors {
  stateIcon: Color;
  stateText: Color;
  workspace: { color: Color; bold: boolean };
  secondary: Color;
}

/** Lays out one row in `width` columns. When everything does not fit,
 * text tokens are dropped from the end first, then the rest share the
 * width one column at a time. */
export function tokenSegments(
  tokens: ResolvedToken[],
  colors: TokenColors,
  width: number,
): Segment[] {
  const fixed = tokens.map((token) =>
    token.kind === "state_icon"
      ? displayWidth(token.text)
      : token.kind === "git_status"
        ? displayWidth(gitText(token))
        : 0
  );
  const flexible = tokens.map((token) =>
    token.kind === "state_icon" || token.kind === "git_status" ? 0 : displayWidth(token.text)
  );
  const minimum = (active: boolean[]) => {
    const indices = active.flatMap((on, index) => on ? [index] : []);
    let total = 0;
    indices.forEach((index, position) => {
      total += fixed[index]! + (flexible[index]! > 0 ? 1 : 0);
      if (position > 0) total += displayWidth(separator(tokens[indices[position - 1]!]!, tokens[index]!));
    });
    return total;
  };
  const active = tokens.map(() => true);
  if (minimum(active) > width) {
    flexible.forEach((size, index) => {
      if (size > 0) active[index] = false;
    });
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      if (flexible[index] === 0) continue;
      active[index] = true;
      if (minimum(active) > width) active[index] = false;
    }
  }
  const visible = active.flatMap((on, index) => on ? [index] : []);
  let separators = 0;
  visible.forEach((index, position) => {
    if (position > 0) separators += displayWidth(separator(tokens[visible[position - 1]!]!, tokens[index]!));
  });
  const fixedWidth = visible.reduce((total, index) => total + fixed[index]!, 0);
  const budgets: number[] = flexible.map((size, index) => active[index] && size > 0 ? 1 : 0);
  let remaining = Math.max(
    0,
    width - separators - fixedWidth - budgets.reduce((total, value) => total + value, 0),
  );
  while (remaining > 0) {
    let grew = false;
    for (let index = 0; index < budgets.length && remaining > 0; index += 1) {
      if (budgets[index]! > 0 && budgets[index]! < flexible[index]!) {
        budgets[index]! += 1;
        remaining -= 1;
        grew = true;
      }
    }
    if (!grew) break;
  }

  const segments: Segment[] = [];
  visible.forEach((index, position) => {
    const token = tokens[index]!;
    if (position > 0) {
      segments.push({ text: separator(tokens[visible[position - 1]!]!, token), color: theme.muted });
    }
    const styled = (text: string, color: Color, bold = false): Segment => ({
      text,
      color: token.style.fg ?? color,
      bold: token.style.bold ?? bold,
      dim: token.style.dim,
    });
    switch (token.kind) {
      case "state_icon":
        segments.push(styled(token.text, colors.stateIcon));
        break;
      case "git_status":
        if (token.ahead) segments.push(styled(`↑${token.ahead}`, theme.success));
        if (token.ahead && token.behind) segments.push(styled(" ", theme.text));
        if (token.behind) segments.push(styled(`↓${token.behind}`, theme.danger));
        break;
      case "state_text":
        segments.push(styled(truncateEnd(token.text, budgets[index]!), colors.stateText));
        break;
      case "workspace":
        segments.push(styled(
          truncateEnd(token.text, budgets[index]!),
          colors.workspace.color,
          colors.workspace.bold,
        ));
        break;
      default:
        segments.push(styled(truncateEnd(token.text, budgets[index]!), colors.secondary));
    }
  });
  return segments;
}

export function sidebarStatusText(status: string): string {
  return status === "done" ? "review" : status;
}
