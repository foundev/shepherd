import { describe, expect, it } from "vitest";
import { applyAgentView, AgentViewError, validateAgentView, type AgentViewEntry } from "../src/agentView.js";
import { parseSidebarConfig, styleForValue } from "../src/config/sidebar.js";
import { resolveRows, tokenSegments } from "../src/client/sidebarTokens.js";
import { MetadataError, MetadataStore } from "../src/server/metadata.js";

describe("MetadataStore", () => {
  it("merges sources with the latest report winning", () => {
    const store = new MetadataStore();
    store.report("a", { title: "first", tokens: { model: "opus" } });
    store.report("b", { title: "second", tokens: { branch: "main" } });
    expect(store.effective()).toMatchObject({
      title: "second",
      tokens: { model: "opus", branch: "main" },
    });
    store.report("a", { tokens: { model: null } });
    expect(store.effective()).toMatchObject({ title: "second", tokens: { branch: "main" } });
    store.report("b", { clearTitle: true });
    expect(store.effective().title).toBe("first");
  });

  it("expires reports after their ttl", () => {
    const store = new MetadataStore();
    store.report("a", { displayAgent: "Pi", ttlMs: 1_000 }, 0);
    expect(store.effective(500).displayAgent).toBe("Pi");
    expect(store.prune(1_000)).toBe(true);
    expect(store.effective(1_000).displayAgent).toBeNull();
  });

  it("ignores stale sequence numbers", () => {
    const store = new MetadataStore();
    expect(store.report("a", { title: "new", seq: 5 })).toBe(true);
    expect(store.report("a", { title: "old", seq: 4 })).toBe(false);
    expect(store.effective().title).toBe("new");
  });

  it("rejects invalid reports with Shepherd's error codes", () => {
    const store = new MetadataStore();
    const code = (fn: () => void) => {
      try {
        fn();
      } catch (error) {
        return (error as MetadataError).code;
      }
      return null;
    };
    expect(code(() => store.report("a", { title: "x", clearTitle: true }))).toBe("invalid_metadata_request");
    expect(code(() => store.report("a", { tokens: { "bad name": "x" } }))).toBe("invalid_metadata_token");
    expect(code(() => store.report("a", { stateLabels: { busy: "x" } }))).toBe("invalid_state_label");
    expect(code(() => store.report("a", { tokens: { a: "1" }, ttlMs: 0 }))).toBe("invalid_metadata_ttl");
    const many = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`t${i}`, "v"]));
    store.report("a", { tokens: many });
    expect(code(() => store.report("b", { tokens: { extra: "v" } }))).toBe("metadata_token_limit");
  });
});

describe("sidebar config", () => {
  it("parses rows, styles and rules", () => {
    const diagnostics: string[] = [];
    const config = parseSidebarConfig({
      agents: {
        rows: [["state_icon", { token: "$model", fg: "#f00", rules: [{ equals: "opus", hide: true }] }]],
        rows_by_agent: { codex: [["agent"]] },
        row_gap: 1,
      },
    }, diagnostics);
    expect(diagnostics).toEqual([]);
    expect(config.agents.row_gap).toBe(1);
    const token = config.agents.rows[0]![1]!;
    expect(token.style.fg).toBe("#ff0000");
    expect(styleForValue(token, "opus")).toBeNull();
    expect(styleForValue(token, "sonnet")).toEqual({ fg: "#ff0000" });
    expect(config.agents.rows_by_agent.codex).toHaveLength(1);
  });

  it("keeps defaults and reports invalid sections", () => {
    const diagnostics: string[] = [];
    const config = parseSidebarConfig({ spaces: { rows: [["nope"]] } }, diagnostics);
    expect(diagnostics[0]).toContain("unknown sidebar token");
    expect(config.spaces.rows.map((row) => row.map((token) => token.token))).toEqual([
      ["state_icon", "workspace"],
      ["branch", "git_status"],
    ]);
    parseSidebarConfig({ agents: { rows_by_agent: { nobody: [] } } }, diagnostics);
    expect(diagnostics[1]).toContain("unknown canonical agent id");
  });

  it("matches numeric and case-folded rules", () => {
    const config = parseSidebarConfig({
      spaces: {
        rows: [[{
          token: "$cost",
          rules: [{ gt: 10, bold: true }, { contains: "FREE", ignore_case: true, dim: true }],
        }]],
      },
    }, []);
    const token = config.spaces.rows[0]![0]!;
    expect(styleForValue(token, "12.5")).toEqual({ bold: true });
    expect(styleForValue(token, "free tier")).toEqual({ dim: true });
    expect(styleForValue(token, "3")).toEqual({});
  });
});

describe("sidebar tokens", () => {
  const colors = { stateIcon: "red", stateText: "red", workspace: { color: "white", bold: true }, secondary: "gray" };
  const text = (segments: { text: string }[]) => segments.map((segment) => segment.text).join("");

  it("drops missing tokens and joins with Shepherd's separators", () => {
    const config = parseSidebarConfig({}, []);
    const rows = resolveRows(config.spaces.rows, {
      state_icon: "●",
      state_text: "working",
      workspace: "repo",
      branch: "main",
      git_status: { ahead: 2, behind: 1 },
      tokens: {},
    });
    expect(rows.map((row) => text(tokenSegments(row, colors, 40)))).toEqual([
      "● repo",
      "main ↑2 ↓1",
    ]);
    const agentRows = resolveRows(config.agents.rows, {
      state_icon: "●",
      state_text: "idle",
      workspace: "repo",
      machine: null,
      tab: "2",
      agent: "claude",
      tokens: {},
    });
    expect(agentRows.map((row) => text(tokenSegments(row, colors, 40)))).toEqual([
      "● repo · 2",
      "claude",
    ]);
  });

  it("drops trailing text tokens before truncating", () => {
    const config = parseSidebarConfig({ agents: { rows: [["state_icon", "workspace", "$a", "$b"]] } }, []);
    const [row] = resolveRows(config.agents.rows, {
      state_icon: "●",
      state_text: "idle",
      workspace: "workspace",
      tokens: { a: "alpha", b: "beta" },
    });
    expect(text(tokenSegments(row!, colors, 40))).toBe("● workspace · alpha · beta");
    expect(text(tokenSegments(row!, colors, 12))).toBe("● w… · … · …");
    expect(text(tokenSegments(row!, colors, 5))).toBe("● be…");
  });
});

describe("agent views", () => {
  const entry = (overrides: Partial<AgentViewEntry>): AgentViewEntry => ({
    status: "idle",
    workspaceId: "w1",
    tabId: "t1",
    paneId: "p1",
    agent: "claude",
    seen: true,
    stateChangeSeq: 1,
    tokens: {},
    workspaceOrder: 0,
    tabOrder: 1,
    paneOrder: 1,
    ...overrides,
  });

  it("filters and sorts entries", () => {
    const view = validateAgentView({
      source: "test",
      label: "Busy",
      filter: {
        op: "all",
        filters: [
          { op: "in", field: "status", values: ["working", "blocked"] },
          { op: "eq", field: "workspace_id", value: { context: "current_workspace_id" } },
        ],
      },
      sort: [{ field: { token: "rank" }, order: "desc" }],
    });
    const entries = [
      entry({ paneId: "a", status: "working", tokens: { rank: "1" } }),
      entry({ paneId: "b", status: "idle" }),
      entry({ paneId: "c", status: "blocked", tokens: { rank: "2" } }),
      entry({ paneId: "d", status: "working", workspaceId: "w2" }),
      entry({ paneId: "e", status: "working" }),
    ];
    const result = applyAgentView(view, { workspaceId: "w1", tabId: "t1" }, entries, (value) => value);
    expect(result.map((value) => value.paneId)).toEqual(["c", "a", "e"]);
  });

  it("rejects malformed views", () => {
    expect(() => validateAgentView({ source: "bad source" })).toThrow(AgentViewError);
    expect(() => validateAgentView({ source: "s", filter: { op: "eq", field: "status", value: "busy" } }))
      .toThrow("unknown agent status");
    expect(() => validateAgentView({ source: "s", filter: { op: "eq", field: "seen", value: "yes" } }))
      .toThrow("value type");
    expect(() => validateAgentView({ source: "s", filter: { op: "all", filters: [] } })).toThrow("must not be empty");
  });
});
