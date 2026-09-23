/** Built-in agent definitions: how each agent is recognised from its
 * command line and which screen rules decide its status. Priorities:
 * blockers 600+, working signals 450-700, idle signals below working so a
 * visible "esc to interrupt" wins over a prompt that is also on screen. */
import { rule, type Manifest, type Rule } from "./manifest.js";

export interface AgentDefinition {
  id: string;
  /** Matched against the foreground command line (wrappers removed). */
  commands: RegExp[];
  rules: Rule[];
}

const command = (...names: string[]) =>
  new RegExp(`(?:^|/)(?:${names.join("|")})(?:\\.js)?(?:\\s|$)`, "i");

/** Signals most agent TUIs share. */
const SHARED: Rule[] = [
  rule("approval_prompt", {
    state: "blocked",
    priority: 600,
    region: "bottom_non_empty_lines(10)",
    visible: true,
    any: [
      { regex: [/\[(?:y\/n|y\/N|Y\/n|yes\/no)\]/i] },
      { regex: [/\((?:y\/n|yes\/no)\)\s*$/im] },
      { regex: [/\b(?:approve|allow|deny)\b[^\n]{0,100}\?/i] },
      { contains: ["waiting for your input"] },
      { contains: ["waiting for approval"] },
      { contains: ["press enter to continue"] },
      { contains: ["select an option"] },
      // A numbered choice list with the cursor on an option.
      { lineRegex: [/^\s*[❯›>]\s*\d+[.)]\s+\S/], contains: ["yes"] },
    ],
  }),
  rule("title_spinner", {
    state: "working",
    priority: 700,
    region: "osc_title",
    regex: [/^[⠀-⣿] /u],
  }),
  rule("progress_busy", {
    state: "working",
    priority: 650,
    region: "osc_progress",
    regex: [/^4;[13];/],
  }),
  rule("interrupt_hint", {
    state: "working",
    priority: 500,
    region: "bottom_non_empty_lines(6)",
    visible: true,
    regex: [/\besc to (?:interrupt|cancel)\b/i],
  }),
  rule("spinner_line", {
    state: "working",
    priority: 450,
    region: "bottom_non_empty_lines(4)",
    lineRegex: [/^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+\S/u],
  }),
  rule("progress_cleared", {
    state: "idle",
    priority: 250,
    region: "osc_progress",
    regex: [/^4;0/],
  }),
];

function agent(id: string, commands: RegExp[], specific: Rule[] = []): AgentDefinition {
  return { id, commands, rules: [...specific, ...SHARED] };
}

export const AGENTS: AgentDefinition[] = [
  agent("claude", [command("claude", "claude-code")], [
    rule("claude_permission", {
      state: "blocked",
      priority: 650,
      region: "bottom_non_empty_lines(12)",
      visible: true,
      any: [
        { regex: [/\bclaude (?:wants|needs) to\b/i] },
        { regex: [/\bpermissions? request\b/i] },
        { regex: [/\bdo you want to (?:proceed|continue|make this edit|run)\b/i] },
      ],
    }),
    rule("claude_thinking", {
      state: "working",
      priority: 500,
      region: "bottom_non_empty_lines(6)",
      regex: [/\bclaude (?:is )?thinking\b/i],
    }),
    rule("claude_prompt", {
      state: "idle",
      priority: 420,
      region: "prompt_box_body",
      visible: true,
      lineRegex: [/^\s*[>❯](?:\s|$)/u],
      not: [{ contains: ["enter to select"] }],
    }),
  ]),
  agent("codex", [command("codex")], [
    rule("codex_approval", {
      state: "blocked",
      priority: 650,
      region: "bottom_non_empty_lines(12)",
      visible: true,
      any: [
        { regex: [/\bapprove commands?\b/i] },
        { regex: [/\bapply patch\?/i] },
        { regex: [/\ballow codex to\b/i] },
      ],
    }),
    rule("codex_working", {
      state: "working",
      priority: 500,
      region: "bottom_non_empty_lines(6)",
      any: [
        { lineRegex: [/^\s*(?:•\s*)?working\b/i] },
        { regex: [/\bcodex (?:is )?(?:thinking|working)\b/i] },
      ],
    }),
    rule("codex_prompt", {
      state: "idle",
      priority: 420,
      region: "bottom_non_empty_lines(3)",
      visible: true,
      lineRegex: [/^›(?:\s|$)/u],
    }),
  ]),
  agent("gemini", [command("gemini")], [
    rule("gemini_approval", {
      state: "blocked",
      priority: 650,
      region: "bottom_non_empty_lines(10)",
      visible: true,
      regex: [/\bapprove (?:this|the) (?:command|action)\b/i],
    }),
    rule("gemini_thinking", {
      state: "working",
      priority: 500,
      region: "bottom_non_empty_lines(6)",
      regex: [/\bgemini (?:is )?(?:thinking|working)\b/i],
    }),
  ]),
  agent("opencode", [command("opencode", "opencode2", "open-code")], [
    rule("opencode_approval", {
      state: "blocked",
      priority: 650,
      region: "bottom_non_empty_lines(10)",
      visible: true,
      regex: [/\bapprove session (?:update|change)\b/i],
    }),
  ]),
  agent("aider", [command("aider")]),
  agent("amp", [command("amp", "amp-local")]),
  agent("antigravity", [command("antigravity", "antigravity-cli", "agy")]),
  agent("cline", [command("cline")]),
  agent("copilot", [command("copilot", "github-copilot", "github copilot", "ghcs")]),
  agent("cursor", [command("cursor", "cursor-agent")]),
  agent("devin", [command("devin", "devin-cli")]),
  agent("droid", [command("droid")]),
  agent("grok", [command("grok")]),
  agent("hermes", [command("hermes", "hermes-agent")]),
  agent("kilo", [command("kilo", "kilo-code")]),
  agent("kimi", [command("kimi", "kimi-code")]),
  agent("kiro", [command("kiro", "kiro-cli")]),
  agent("letta", [command("letta", "letta-code")]),
  agent("maki", [command("maki")]),
  agent("muse", [command("muse", "muse-code", "muse-cli")]),
  agent("pi", [command("pi")]),
  agent("qodercli", [command("qodercli", "qoder")]),
  agent("qwen", [command("qwen", "qwen-code")]),
];

const BY_ID = new Map(AGENTS.map((definition) => [definition.id, definition]));

export function detectAgentFromCommand(commandLine: string): string | null {
  for (const definition of AGENTS) {
    if (definition.commands.some((pattern) => pattern.test(commandLine))) {
      return definition.id;
    }
  }
  return null;
}

export function manifestFor(agent: string): Manifest | null {
  const definition = BY_ID.get(agent);
  return definition ? { id: definition.id, rules: definition.rules } : null;
}
