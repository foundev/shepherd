/** Metadata that integrations and scripts report about panes and
 * workspaces: a title, the agent name to display, per-status labels and
 * named tokens for the sidebar. Each source's report can expire. */

export interface PaneMetadataReport {
  title?: string | null;
  clearTitle?: boolean;
  displayAgent?: string | null;
  clearDisplayAgent?: boolean;
  stateLabels?: Record<string, string>;
  clearStateLabels?: boolean;
  /** Null removes a token. */
  tokens?: Record<string, string | null>;
  ttlMs?: number;
  /** Reports with a sequence at or below the source's last are ignored. */
  seq?: number;
}

/** A rejected report; `code` matches Shepherd's error codes. */
export class MetadataError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface EffectiveMetadata {
  title: string | null;
  displayAgent: string | null;
  stateLabels: Record<string, string>;
  tokens: Record<string, string>;
}

/** A value and when it was reported, so the newest value wins per field. */
interface Stamped {
  value: string;
  order: number;
}

interface SourceEntry {
  title: Stamped | null;
  displayAgent: Stamped | null;
  stateLabels: Record<string, Stamped>;
  tokens: Record<string, Stamped>;
  expiresAt: number | null;
  seq: number | null;
}

const TOKEN_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const clean = (value: string, max: number) =>
  value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, max);

/** Metadata from several sources; later reports win per field. */
export class MetadataStore {
  private readonly sources = new Map<string, SourceEntry>();
  private order = 0;

  /** Applies a report; false when it was stale and ignored. */
  report(source: string, report: PaneMetadataReport, now = Date.now()): boolean {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(source)) {
      throw new MetadataError("invalid_metadata_source", `invalid metadata source: ${source}`);
    }
    if (
      (typeof report.title === "string" && report.clearTitle) ||
      (typeof report.displayAgent === "string" && report.clearDisplayAgent) ||
      (Object.keys(report.stateLabels ?? {}).length > 0 && report.clearStateLabels)
    ) {
      throw new MetadataError("invalid_metadata_request", "cannot set and clear the same metadata field");
    }
    if (report.ttlMs !== undefined && !(report.ttlMs >= 1 && report.ttlMs <= 86_400_000)) {
      throw new MetadataError("invalid_metadata_ttl", "ttl_ms must be between 1 and 86400000");
    }
    for (const status of Object.keys(report.stateLabels ?? {})) {
      if (!["idle", "working", "blocked", "done", "unknown"].includes(status)) {
        throw new MetadataError("invalid_state_label", `unknown state label: ${status}`);
      }
    }
    const tokens = Object.entries(report.tokens ?? {});
    if (tokens.length > 16) {
      throw new MetadataError("invalid_metadata_token", "at most 16 tokens per report");
    }
    for (const [name] of tokens) {
      if (!TOKEN_NAME.test(name)) {
        throw new MetadataError("invalid_metadata_token", `invalid metadata token name: ${name}`);
      }
    }
    const previous = this.sources.get(source);
    if (
      report.seq !== undefined && previous?.seq != null && report.seq <= previous.seq
    ) {
      return false;
    }
    const entry: SourceEntry = previous && !this.expired(previous, now)
      ? { ...previous, stateLabels: { ...previous.stateLabels }, tokens: { ...previous.tokens } }
      : { title: null, displayAgent: null, stateLabels: {}, tokens: {}, expiresAt: null, seq: null };
    if (report.seq !== undefined) entry.seq = report.seq;
    const order = ++this.order;
    const stamp = (value: string, max: number): Stamped | null => {
      const text = clean(value, max).trim();
      return text ? { value: text, order } : null;
    };
    if (report.clearTitle) entry.title = null;
    if (typeof report.title === "string") entry.title = stamp(report.title, 256);
    if (report.clearDisplayAgent) entry.displayAgent = null;
    if (typeof report.displayAgent === "string") entry.displayAgent = stamp(report.displayAgent, 64);
    if (report.clearStateLabels) entry.stateLabels = {};
    for (const [status, label] of Object.entries(report.stateLabels ?? {})) {
      const value = stamp(label, 64);
      if (value) entry.stateLabels[status] = value;
      else delete entry.stateLabels[status];
    }
    for (const [name, value] of tokens) {
      if (value === null) delete entry.tokens[name];
      else entry.tokens[name] = { value: clean(String(value), 128), order };
    }
    const otherKeys = new Set<string>();
    for (const [other, existing] of this.sources) {
      if (other !== source && !this.expired(existing, now)) {
        for (const name of Object.keys(existing.tokens)) otherKeys.add(name);
      }
    }
    for (const name of Object.keys(entry.tokens)) otherKeys.add(name);
    if (otherKeys.size > 16) {
      throw new MetadataError("metadata_token_limit", "metadata may contain at most 16 tokens");
    }
    entry.expiresAt = report.ttlMs ? now + Math.min(report.ttlMs, 86_400_000) : null;
    this.sources.set(source, entry);
    return true;
  }

  clear(source?: string): void {
    if (source) this.sources.delete(source);
    else this.sources.clear();
  }

  /** Drops expired reports; true when something was removed. */
  prune(now = Date.now()): boolean {
    let removed = false;
    for (const [source, entry] of this.sources) {
      if (this.expired(entry, now)) {
        this.sources.delete(source);
        removed = true;
      }
    }
    return removed;
  }

  effective(now = Date.now()): EffectiveMetadata {
    let title: Stamped | null = null;
    let displayAgent: Stamped | null = null;
    const stateLabels: Record<string, Stamped> = {};
    const tokens: Record<string, Stamped> = {};
    const newer = (current: Stamped | null | undefined, next: Stamped | null) =>
      next && (!current || next.order > current.order) ? next : current ?? null;
    for (const entry of this.sources.values()) {
      if (this.expired(entry, now)) continue;
      title = newer(title, entry.title);
      displayAgent = newer(displayAgent, entry.displayAgent);
      for (const [key, value] of Object.entries(entry.stateLabels)) {
        stateLabels[key] = newer(stateLabels[key], value)!;
      }
      for (const [key, value] of Object.entries(entry.tokens)) {
        tokens[key] = newer(tokens[key], value)!;
      }
    }
    const values = (record: Record<string, Stamped>) =>
      Object.fromEntries(Object.entries(record).map(([key, stamped]) => [key, stamped.value]));
    return {
      title: title?.value ?? null,
      displayAgent: displayAgent?.value ?? null,
      stateLabels: values(stateLabels),
      tokens: values(tokens),
    };
  }

  private expired(entry: SourceEntry, now: number): boolean {
    return entry.expiresAt !== null && entry.expiresAt <= now;
  }
}
