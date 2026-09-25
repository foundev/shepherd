/** Session resume for agents: a pane
 * whose agent reported a session through an integration is restarted with
 * the agent's own resume command after a daemon restart. */

export interface AgentSession {
  /** Reporting integration, e.g. "shepherd:claude". */
  source: string;
  agent: string;
  /** Session id, or a session file path for agents that use paths. */
  value: string;
}

/** Only official integrations may name a session to resume. */
function officialSource(source: string, agent: string): boolean {
  const integration = agent === "agy" ? "antigravity_cli" : agent;
  return source === `shepherd:${integration}`;
}

export function resumeArgv(session: AgentSession): string[] | null {
  if (!officialSource(session.source, session.agent)) return null;
  const id = session.value;
  if (!id || id.startsWith("-")) return null;
  switch (session.agent) {
    case "claude":
      return ["claude", "--resume", id];
    case "codex":
      return ["codex", "resume", id];
    case "muse":
      return ["muse", "resume", id];
    case "copilot":
      return ["copilot", `--resume=${id}`];
    case "devin":
      return ["devin", "--resume", id];
    case "droid":
      return ["droid", "--resume", id];
    case "kimi":
      return ["kimi", "--session", id];
    case "mastracode":
      return ["mastracode", "--thread", id];
    case "pi":
      return ["pi", "--session", id];
    case "omp":
      return ["omp", `--resume=${id}`];
    case "hermes":
      return ["hermes", "--resume", id];
    case "opencode":
      return ["opencode", "--session", id];
    case "qodercli":
      return ["qodercli", "--resume", id];
    case "qwen":
      return ["qwen", "--resume", id];
    case "kilo":
      return ["kilo", "--session", id];
    case "cursor":
      return ["cursor-agent", "--resume", id];
    case "agy":
      return ["agy", "--conversation", id];
    case "grok":
      return ["grok", "--resume", id];
    case "letta": {
      const agentId = id.startsWith("default:") ? id.slice("default:".length) : null;
      if (agentId === "") return null;
      return agentId
        ? ["letta", "--conversation", "default", "--agent", agentId]
        : ["letta", "--conversation", id];
    }
    default:
      return null;
  }
}

export function shellCommand(argv: string[]): string {
  return argv
    .map((part) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(part)
      ? part
      : `'${part.replaceAll("'", "'\\''")}'`)
    .join(" ");
}
