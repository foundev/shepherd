import { describe, it, expect } from "vitest";
import { updateTask } from "../src/server/tasks.js";

describe("persistent task context", () => {
  it("resets previous results when the objective changes", () => {
    const previous = updateTask(null, { title: "A", summary: "Done", checkStatus: "passed", checkSummary: "npm test", review: "reviewed" });
    const next = updateTask(previous, { title: "B" });
    expect(next).toMatchObject({ title: "B", summary: "", checkStatus: "unknown", checkSummary: "", review: "none" });
    expect(previous.checkStatus).toBe("passed");
  });
  it("keeps reported checks separate from review and reopens changed results", () => {
    const task = updateTask(null, { title: "A", checkStatus: "unknown", review: "requested" });
    const reviewed = updateTask(task, { review: "reviewed" });
    expect(reviewed.checkStatus).toBe("unknown");
    expect(updateTask(reviewed, { summary: "More changes arrived" }).review).toBe("requested");
  });
  it("rejects conflicting edits and invalid reports", () => {
    const task = updateTask(null, { title: "A" });
    expect(() => updateTask(task, { summary: "stale" }, "user", 0)).toThrow("changed");
    expect(() => updateTask(task, { checkStatus: "great" } as never)).toThrow("invalid");
    expect(() => updateTask(task, { summary: "x".repeat(2001) })).toThrow("2000");
    expect(() => updateTask(task, { revision: 9 } as never)).toThrow("invalid");
  });
  it("bounds activity and strips terminal controls from task text", () => {
    let task = updateTask(null, { title: "A\x1b[31m" });
    for (let i = 0; i < 20; i++) task = updateTask(task, { summary: String(i) });
    expect(task.activity).toHaveLength(12);
    expect(task.title).not.toContain("\x1b");
  });
});
