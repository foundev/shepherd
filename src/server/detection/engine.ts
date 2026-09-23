/** Evaluates agent-detection manifests against a pane's screen text, as
 * Shepherd's engine does: every rule is checked against its region and the
 * highest-priority match wins (ties go to the earlier rule). */
import { gateMatches, lines, type DetectedState, type Manifest, type Rule } from "./manifest.js";

export interface DetectionInput {
  /** Plain screen text: about one screen, lines right-trimmed, ending in
   * a newline when non-empty. */
  text: string;
  oscTitle: string;
  oscProgress: string;
}

export interface EvaluatedRule {
  rule: Rule;
  matched: boolean;
  regionText: string;
}

export interface Detection {
  state: DetectedState;
  rule: Rule | null;
  visibleIdle: boolean;
  visibleBlocker: boolean;
  visibleWorking: boolean;
  skipStateUpdate: boolean;
  fallbackReason: string | null;
  evaluated: EvaluatedRule[];
}

export function evaluate(manifest: Manifest | null, input: DetectionInput): Detection {
  if (!manifest) {
    return {
      state: "unknown",
      rule: null,
      visibleIdle: false,
      visibleBlocker: false,
      visibleWorking: false,
      skipStateUpdate: false,
      fallbackReason: "no_matching_signal",
      evaluated: [],
    };
  }
  let matched: Rule | null = null;
  const evaluated: EvaluatedRule[] = [];
  for (const rule of manifest.rules) {
    const regionText = region(input, rule.region);
    const ok = gateMatches(rule.gate, regionText);
    evaluated.push({ rule, matched: ok, regionText });
    if (ok && (!matched || rule.priority > matched.priority)) matched = rule;
  }
  if (!matched) {
    return {
      state: "unknown",
      rule: null,
      visibleIdle: false,
      visibleBlocker: false,
      visibleWorking: false,
      skipStateUpdate: false,
      fallbackReason: "no_matching_signal",
      evaluated,
    };
  }
  const state = matched.state;
  return {
    state,
    rule: matched,
    visibleIdle: matched.visibleIdle && state === "idle",
    visibleBlocker: matched.visibleBlocker && state === "blocked",
    visibleWorking: matched.visibleWorking && state === "working",
    skipStateUpdate: matched.skipStateUpdate,
    fallbackReason: null,
    evaluated,
  };
}

const isBlank = (line: string) => line.trim() === "";

/** Byte offset of line `index`, assuming each line ends with one \n. */
function lineStart(split: string[], index: number): number {
  let offset = 0;
  for (let line = 0; line < index; line += 1) offset += (split[line]?.length ?? 0) + 1;
  return offset;
}

function joinFrom(split: string[], index: number): string {
  if (index >= split.length) return "";
  return `${split.slice(index).join("\n")}\n`;
}

const isPromptLine = (line: string) => line === "›" || line.startsWith("› ");
const isBlockMarker = (line: string) => /^[•■✗✓]/u.test(line);

/** A line of `─` (U+2500): all rule, or at least 3 before a label. */
export function isHorizontalRule(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("─")) return false;
  let count = 0;
  for (const character of trimmed) {
    if (character !== "─") break;
    count += 1;
  }
  const suffix = [...trimmed].slice(count).join("").trimStart();
  return suffix === "" || count >= 3;
}

/** Index of the current prompt line: the last prompt line with no block
 * marker after it. */
function currentPrompt(split: string[]): number {
  let prompt = -1;
  for (let index = 0; index < split.length; index += 1) {
    if (isPromptLine(split[index] ?? "")) prompt = index;
  }
  if (prompt === -1) return -1;
  for (let index = prompt + 1; index < split.length; index += 1) {
    if (isBlockMarker(split[index] ?? "")) return -1;
  }
  return prompt;
}

function lastBlockMarkerAbove(split: string[], prompt: number): number {
  for (let index = prompt - 1; index >= 0; index -= 1) {
    if (isBlockMarker(split[index] ?? "")) return index;
  }
  return -1;
}

/** Top border of the prompt box: the second horizontal rule from the
 * bottom. */
function promptBoxTop(split: string[]): number {
  let seen = 0;
  for (let index = split.length - 1; index >= 0; index -= 1) {
    if (isHorizontalRule(split[index] ?? "")) {
      seen += 1;
      if (seen === 2) return index;
    }
  }
  return -1;
}

export function region(input: DetectionInput, name: string): string {
  const text = input.text;
  if (name === "osc_title") return input.oscTitle;
  if (name === "osc_progress") return input.oscProgress;
  if (name === "whole_recent") return text;
  const split = lines(text);

  const bottom = /^bottom_lines\((\d+)\)$/.exec(name);
  if (bottom) {
    const count = Number(bottom[1]);
    return count === 0 ? "" : joinFrom(split, Math.max(0, split.length - count));
  }
  const bottomNonEmpty = /^bottom_non_empty_lines\((\d+)\)$/.exec(name);
  if (bottomNonEmpty) {
    const count = Number(bottomNonEmpty[1]);
    if (count === 0) return "";
    let found = 0;
    let start = -1;
    for (let index = split.length - 1; index >= 0; index -= 1) {
      if (!isBlank(split[index] ?? "")) {
        found += 1;
        start = index;
        if (found === count) break;
      }
    }
    return start === -1 ? "" : joinFrom(split, start);
  }
  const top = /^top_non_empty_lines\((\d+)\)$/.exec(name);
  if (top) {
    const count = Number(top[1]);
    let found = 0;
    for (let index = 0; index < split.length; index += 1) {
      if (!isBlank(split[index] ?? "")) {
        found += 1;
        if (found === count) return text.slice(0, lineStart(split, index + 1));
      }
    }
    return text;
  }

  switch (name) {
    case "after_last_prompt_marker": {
      let prompt = -1;
      split.forEach((line, index) => {
        if (isPromptLine(line)) prompt = index;
      });
      return prompt === -1 ? text : joinFrom(split, prompt + 1);
    }
    case "before_current_prompt_marker": {
      const prompt = currentPrompt(split);
      return prompt === -1 ? text : text.slice(0, lineStart(split, prompt));
    }
    case "whole_recent_without_current_prompt_marker":
      return currentPrompt(split) === -1 ? text : "";
    case "current_prompt_block_marker": {
      const prompt = currentPrompt(split);
      if (prompt === -1) return "";
      const marker = lastBlockMarkerAbove(split, prompt);
      return marker === -1 ? "" : `${split[marker]}\n`;
    }
    case "after_current_prompt_block_marker": {
      const prompt = currentPrompt(split);
      if (prompt === -1) return "";
      const marker = lastBlockMarkerAbove(split, prompt);
      return marker === -1 ? "" : joinFrom(split, marker);
    }
    case "prompt_box_body": {
      const topBorder = promptBoxTop(split);
      if (topBorder === -1) return "";
      let end = split.length;
      for (let index = topBorder + 1; index < split.length; index += 1) {
        if (isHorizontalRule(split[index] ?? "")) {
          end = index;
          break;
        }
      }
      const body = split.slice(topBorder + 1, end);
      return body.length ? `${body.join("\n")}\n` : "";
    }
    case "above_prompt_box": {
      const topBorder = promptBoxTop(split);
      return topBorder === -1 ? text : text.slice(0, lineStart(split, topBorder));
    }
    case "last_non_empty_above_prompt_box": {
      const topBorder = promptBoxTop(split);
      const above = topBorder === -1 ? split : split.slice(0, topBorder);
      for (let index = above.length - 1; index >= 0; index -= 1) {
        if (!isBlank(above[index] ?? "")) return above[index] ?? "";
      }
      return "";
    }
    case "after_last_horizontal_rule": {
      let rule = -1;
      split.forEach((line, index) => {
        if (isHorizontalRule(line)) rule = index;
      });
      return rule === -1 ? text : joinFrom(split, rule + 1);
    }
    default:
      return "";
  }
}

/** `agent explain`: the decision and each rule's evidence. */
export function explain(agent: string, detection: Detection) {
  const preview = (value: string) => value.length > 240 ? `${value.slice(0, 240)}...` : value;
  return {
    agent,
    state: detection.state,
    manifest_source: "built-in",
    matched_rule: detection.rule
      ? {
        id: detection.rule.id,
        priority: detection.rule.priority,
        region: detection.rule.region,
        state: detection.rule.state,
      }
      : null,
    visible_idle: detection.visibleIdle,
    visible_blocker: detection.visibleBlocker,
    visible_working: detection.visibleWorking,
    skip_state_update: detection.skipStateUpdate,
    fallback_reason: detection.fallbackReason,
    evaluated_rules: detection.evaluated.map((entry) => ({
      id: entry.rule.id,
      priority: entry.rule.priority,
      region: entry.rule.region,
      state: entry.rule.state,
      matched: entry.matched,
      evidence: {
        contains: entry.rule.gate.contains,
        regex: entry.rule.gate.regex.map((pattern) => pattern.source),
        line_regex: entry.rule.gate.lineRegex.map((pattern) => pattern.source),
        all_count: entry.rule.gate.all.length,
        any_count: entry.rule.gate.any.length,
        not_count: entry.rule.gate.not.length,
        region_bytes: Buffer.byteLength(entry.regionText),
        region_preview: preview(entry.regionText),
      },
    })),
  };
}
