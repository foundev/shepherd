/** Detection rules: each matches a region of a pane's screen text with
 * substring and regex gates that can be combined with all/any/not. The
 * rules themselves are defined in code (see agents.ts). */

export type DetectedState = "idle" | "working" | "blocked" | "unknown";

export interface Gate {
  /** Every needle must appear (case-insensitive). */
  contains: string[];
  /** Every pattern must match somewhere in the region. */
  regex: RegExp[];
  /** Every pattern must match at least one line of the region. */
  lineRegex: RegExp[];
  all: Gate[];
  /** At least one must match (when non-empty). */
  any: Gate[];
  /** None may match. */
  not: Gate[];
}

export interface Rule {
  id: string;
  state: DetectedState;
  priority: number;
  region: string;
  /** The screen shows live idle UI, such as an empty prompt box. */
  visibleIdle: boolean;
  /** The screen shows UI that needs the user (published immediately). */
  visibleBlocker: boolean;
  visibleWorking: boolean;
  /** A viewer screen (transcript, history): make no state change. */
  skipStateUpdate: boolean;
  gate: Gate;
}

export interface Manifest {
  id: string;
  rules: Rule[];
}

export interface GateSpec {
  contains?: string[];
  regex?: RegExp[];
  lineRegex?: RegExp[];
  all?: GateSpec[];
  any?: GateSpec[];
  not?: GateSpec[];
}

export function gate(spec: GateSpec): Gate {
  return {
    contains: (spec.contains ?? []).map((needle) => needle.toLowerCase()),
    regex: spec.regex ?? [],
    lineRegex: spec.lineRegex ?? [],
    all: (spec.all ?? []).map(gate),
    any: (spec.any ?? []).map(gate),
    not: (spec.not ?? []).map(gate),
  };
}

export interface RuleSpec extends GateSpec {
  state: DetectedState;
  priority: number;
  region?: string;
  visible?: boolean;
  skipStateUpdate?: boolean;
}

/** Builds a rule; `visible` sets the flag matching the rule's state. */
export function rule(id: string, spec: RuleSpec): Rule {
  const visible = spec.visible ?? false;
  return {
    id,
    state: spec.state,
    priority: spec.priority,
    region: spec.region ?? "whole_recent",
    visibleIdle: visible && spec.state === "idle",
    visibleBlocker: visible && spec.state === "blocked",
    visibleWorking: visible && spec.state === "working",
    skipStateUpdate: spec.skipStateUpdate ?? false,
    gate: gate(spec),
  };
}

/** Splits on \n, dropping a trailing \r and the empty element after a
 * final newline. */
export function lines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
}

export function gateMatches(gate: Gate, text: string): boolean {
  if (gate.contains.length) {
    const lower = text.toLowerCase();
    if (!gate.contains.every((needle) => lower.includes(needle))) return false;
  }
  if (!gate.regex.every((pattern) => pattern.test(text))) return false;
  if (gate.lineRegex.length) {
    const split = lines(text);
    if (!gate.lineRegex.every((pattern) => split.some((line) => pattern.test(line)))) return false;
  }
  if (!gate.all.every((nested) => gateMatches(nested, text))) return false;
  if (gate.any.length && !gate.any.some((nested) => gateMatches(nested, text))) return false;
  if (gate.not.some((nested) => gateMatches(nested, text))) return false;
  return true;
}
