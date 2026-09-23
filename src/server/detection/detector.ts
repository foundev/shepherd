/** Per-pane agent state, following Shepherd's detection loop: screen rules
 * after a startup grace, hysteresis before working turns idle, hook
 * reports as the authority, and "done" meaning an unseen completion. */
import type { AgentSignal, AgentStatus } from "../../types.js";
import { manifestFor } from "./agents.js";
import { evaluate, type Detection, type DetectionInput } from "./engine.js";
import type { DetectedState } from "./manifest.js";

export const STARTUP_GRACE_MS = 3_000;
export const IDLE_CONFIRM_READINGS = 3;
export const IDLE_CONFIRM_MS = 700;
/** Probes without the agent before it is forgotten (when something else
 * took the foreground). */
export const AGENT_MISS_LIMIT = 6;
export const HOOK_TTL_MS = 120_000;

export function validateHookReport(state: string, source: string, ttlMs = HOOK_TTL_MS): void {
  if (!["idle", "working", "blocked", "unknown"].includes(state)) throw new Error("invalid agent state");
  if (typeof source !== "string" || !source.trim() || source.length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(source)) throw new Error("invalid agent source");
  if (!Number.isFinite(ttlMs) || ttlMs < 1000 || ttlMs > 3_600_000) throw new Error("ttlMs must be between 1000 and 3600000");
}

export class AgentDetector {
  agent: string | null = null;
  /** State from the screen rules (or a process exit). */
  private screenState: DetectedState = "unknown";
  private visibleBlocker = false;
  private visibleBlockerAt = 0;
  /** State reported by a hook integration, which wins over the screen. */
  private hook: { state: DetectedState; at: number; source: string; expiresAt: number } | null = null;
  private expiredHook = false;
  private hadActivity = false;
  private observedAt = 0;
  private changedAt = 0;
  private clock = 0;
  /** False after a completion nobody has looked at yet: shown as done. */
  private seen = true;
  private graceUntil = 0;
  private contentSequence = 0;
  private scannedSequence = -1;
  private pendingIdle: { readings: number; since: number } | null = null;
  private exitReported = false;
  private misses = 0;
  lastDetection: Detection | null = null;
  stateChangeSequence = 0;
  completionSequence = 0;

  signal(): AgentSignal {
    if (this.exitReported) return { source: "process", confidence: "inferred", reason: "Agent process ended; outcome needs review", observedAt: this.observedAt, changedAt: this.changedAt, expiresAt: null };
    if (this.hook && this.effectiveState() === this.hook.state) return {
      source: "integration", confidence: "reported", reason: `${this.hook.source} reported ${this.hook.state}`,
      observedAt: this.hook.at, changedAt: this.changedAt, expiresAt: this.hook.expiresAt,
    };
    const rule = this.lastDetection?.rule;
    if (this.agent && rule && this.screenState !== "unknown") return {
      source: "screen", confidence: "inferred", reason: `Screen matches ${rule.id.replace(/_/g, " ")}`,
      observedAt: this.observedAt, changedAt: this.changedAt, expiresAt: null,
    };
    return { source: "none", confidence: "unknown", reason: this.expiredHook
      ? "Integration report expired; inspect the terminal"
      : "No reliable status signal; inspect the terminal", observedAt: this.observedAt, changedAt: this.changedAt, expiresAt: null };
  }

  /** Output arrived; the screen may have changed. */
  noteOutput(): void {
    this.contentSequence += 1;
  }

  get pendingConfirmation(): boolean {
    return this.pendingIdle !== null;
  }

  status(): AgentStatus {
    if (!this.agent) return "unknown";
    const state = this.effectiveState();
    if (state === "idle" && !this.seen) return "done";
    return state;
  }

  effectiveState(): DetectedState {
    if (this.hook) {
      if (
        this.visibleBlocker &&
        this.hook.state !== "blocked" &&
        this.visibleBlockerAt > this.hook.at
      ) {
        return "blocked";
      }
      if (this.screenState === "working" && this.observedAt > this.hook.at) return "working";
      return this.hook.state;
    }
    return this.screenState;
  }

  /** The user looked at the pane: a completion is no longer news. */
  markSeen(): boolean {
    if (this.seen) return false;
    this.seen = true;
    return true;
  }

  /** Result of a foreground-process probe. Returns true when the agent or
   * status changed. */
  probe(
    found: string | null,
    shellInForeground: boolean,
    now: number,
    suppressed: boolean,
  ): boolean {
    this.clock = now;
    if (found) {
      this.misses = 0;
      if (found === this.agent && !this.exitReported) return false;
      this.agent = found;
      this.reset(now);
      return true;
    }
    if (!this.agent) return false;
    // Integrations can recognize wrappers the process matcher cannot. Keep
    // their live lease; a real PTY exit uses exited() directly.
    if (this.hook && now < this.hook.expiresAt) return false;
    if (shellInForeground) {
      if (!this.exitReported) {
        // First probe after exit: publish the completion, forget next time.
        return this.exited(now, suppressed);
      }
      this.clear();
      return true;
    }
    this.misses += 1;
    if (this.misses >= AGENT_MISS_LIMIT) {
      this.clear();
      return true;
    }
    return false;
  }

  exited(now: number, suppressed: boolean): boolean {
    this.clock = now;
    this.exitReported = true;
    this.hook = null;
    this.observedAt = now;
    return this.applyScreen("idle", suppressed);
  }

  /** Sets the agent directly (for panes started with an agent command). */
  setAgent(agent: string | null, now: number): boolean {
    if (agent === this.agent && !this.exitReported) return false;
    if (agent) {
      this.agent = agent;
      this.reset(now);
    } else {
      this.clear();
    }
    return true;
  }

  reportHook(state: DetectedState, source: string, now: number, suppressed: boolean, ttlMs = HOOK_TTL_MS): boolean {
    validateHookReport(state, source, ttlMs);
    this.clock = now;
    const before = this.status();
    const previous = this.effectiveState();
    this.hook = { state, at: now, source, expiresAt: now + ttlMs };
    this.expiredHook = false;
    this.trackCompletion(previous, this.effectiveState(), suppressed);
    return this.status() !== before;
  }

  releaseHook(): boolean {
    const before = this.status();
    this.hook = null;
    return this.status() !== before;
  }

  /** One detection tick. Returns true when the published status changed. */
  tick(now: number, read: () => DetectionInput, suppressed: boolean): boolean {
    this.clock = now;
    const before = this.status();
    if (this.hook && now >= this.hook.expiresAt) {
      this.hook = null;
      this.expiredHook = true;
      // Re-evaluate the screen without inheriting an old idle observation.
      this.screenState = "unknown";
      this.seen = true;
      this.scannedSequence = -1;
    }
    if (!this.agent || this.exitReported) return false;
    if (now < this.graceUntil) return false;
    if (
      this.screenState === "idle" &&
      !this.pendingIdle &&
      this.contentSequence === this.scannedSequence
    ) {
      return false;
    }
    this.scannedSequence = this.contentSequence;
    const detection = evaluate(manifestFor(this.agent), read());
    if (detection.rule?.id !== this.lastDetection?.rule?.id || detection.state !== this.lastDetection?.state) this.observedAt = now;
    this.lastDetection = detection;
    if (detection.skipStateUpdate) return false;

    this.visibleBlocker = detection.visibleBlocker;
    if (detection.visibleBlocker) this.visibleBlockerAt = this.observedAt;

    const next = detection.state;
    if (
      this.screenState === "working" &&
      next === "idle" &&
      !detection.visibleIdle &&
      !detection.visibleBlocker
    ) {
      // Hold a plain working → idle change until it is confirmed.
      this.pendingIdle ??= { readings: 0, since: now };
      this.pendingIdle.readings += 1;
      if (
        this.pendingIdle.readings < IDLE_CONFIRM_READINGS &&
        now - this.pendingIdle.since < IDLE_CONFIRM_MS
      ) {
        return false;
      }
    }
    this.pendingIdle = null;
    this.applyScreen(next, suppressed);
    if (this.status() !== before) this.changedAt = now;
    return this.status() !== before;
  }

  private applyScreen(next: DetectedState, suppressed: boolean): boolean {
    const before = this.status();
    const previous = this.effectiveState();
    this.screenState = next;
    this.trackCompletion(previous, this.effectiveState(), suppressed);
    return this.status() !== before;
  }

  /** Working or blocked → idle is a completion; it stays "done" until the
   * user looks, unless they were already looking. */
  private trackCompletion(
    previous: DetectedState,
    next: DetectedState,
    suppressed: boolean,
  ): void {
    if (next === "working" || next === "blocked") this.hadActivity = true;
    if (previous === next) return;
    this.changedAt = this.clock;
    this.stateChangeSequence += 1;
    if (next === "idle" && this.hadActivity) {
      this.completionSequence += 1;
      this.seen = suppressed;
      this.hadActivity = false;
    } else if (next !== "idle") {
      this.seen = true;
    }
  }

  private reset(now: number): void {
    this.clock = now;
    this.changedAt = now;
    this.screenState = "unknown";
    this.visibleBlocker = false;
    this.hook = null;
    this.expiredHook = false;
    this.hadActivity = false;
    this.observedAt = now;
    this.lastDetection = null;
    this.seen = true;
    this.pendingIdle = null;
    this.exitReported = false;
    this.misses = 0;
    this.graceUntil = now + STARTUP_GRACE_MS;
    this.scannedSequence = -1;
    this.stateChangeSequence += 1;
  }

  private clear(): void {
    this.agent = null;
    this.screenState = "unknown";
    this.visibleBlocker = false;
    this.hook = null;
    this.expiredHook = false;
    this.hadActivity = false;
    this.lastDetection = null;
    this.seen = true;
    this.pendingIdle = null;
    this.exitReported = false;
    this.misses = 0;
    this.stateChangeSequence += 1;
  }
}
