import type { AgentTask, AgentTaskPatch } from "../types.js";

const LIMITS = { title: 160, summary: 2000, nextAction: 1000, blocker: 1000, checkSummary: 1000 };

/** Bounded, explicitly reported task context, independent of terminal focus. */
export function updateTask(
  current: AgentTask | null,
  patch: AgentTaskPatch,
  source = "user",
  expectedRevision?: number,
  now = Date.now(),
): AgentTask {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("task patch must be an object");
  if (expectedRevision !== undefined && expectedRevision !== (current?.revision ?? 0)) {
    throw new Error("Task changed while you were editing. Reopen it and try again.");
  }
  if (typeof source !== "string" || !source.trim() || source.length > 80) throw new Error("invalid task source");
  source = source.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  const clean: AgentTaskPatch = {};
  for (const [key, value] of Object.entries(patch)) {
    if (Object.hasOwn(LIMITS, key)) {
      const limit = LIMITS[key as keyof typeof LIMITS];
      if (typeof value !== "string" || value.length > limit) throw new Error(`${key} must be text of at most ${limit} characters`);
      Object.assign(clean, { [key]: value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim() });
    } else if (key === "checkStatus" && ["unknown", "running", "passed", "failed"].includes(value)) {
      clean.checkStatus = value;
    } else if (key === "review" && ["none", "requested", "reviewed"].includes(value)) {
      clean.review = value;
    } else {
      throw new Error(`invalid task field: ${key}`);
    }
  }
  if (!Object.keys(clean).length) throw new Error("task patch is empty");
  const task: AgentTask = current ?? {
    title: "", summary: "", nextAction: "", blocker: "", checkStatus: "unknown", checkSummary: "",
    review: "none", revision: 0, updatedAt: now, source, reviewRequestedAt: null, activity: [],
  };
  const changes = Object.keys(clean).filter(key => clean[key as keyof AgentTaskPatch] !== task[key as keyof AgentTaskPatch]);
  // A new task must not inherit the previous task's successful checks or review.
  const replacing = clean.title !== undefined && clean.title !== task.title;
  const base = replacing ? { ...task, summary: "", nextAction: "", blocker: "", checkStatus: "unknown" as const,
    checkSummary: "", review: "none" as const, reviewRequestedAt: null } : task;
  const next = { ...base, ...clean };
  if (changes.length && task.review === "reviewed" && clean.review === undefined && !replacing) next.review = "requested";
  const reviewRequestedAt = next.review === "requested" ? task.reviewRequestedAt ?? now : null;
  const text = replacing ? `Task: ${next.title || "untitled"}`
    : clean.review === "reviewed" ? "Review acknowledged"
    : clean.review === "requested" ? "Review requested"
    : `Updated ${changes.join(", ") || "context"}`;
  return { ...next, reviewRequestedAt, revision: task.revision + 1, updatedAt: now, source,
    activity: [...task.activity, { at: now, text, source }].slice(-12) };
}
