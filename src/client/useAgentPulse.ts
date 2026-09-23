import { useEffect, useState } from "react";
import type { StateView } from "../types.js";

/** A slow activity cue that runs only while an unblocked agent is working. */
export function useAgentPulse(state: StateView | null): number {
  const local = state?.panes.filter((pane) => pane.agent).map((pane) => pane.status) ?? [];
  const remote = state?.machines.filter((machine) => machine.status === "online")
    .flatMap((machine) => machine.remote?.agents.map((agent) => agent.status) ?? []) ?? [];
  const statuses = [...local, ...remote];
  const animate = statuses.includes("working") && !statuses.includes("blocked");
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!animate) return;
    const timer = setInterval(() => setFrame((current) => (current + 1) % 4), 800);
    return () => clearInterval(timer);
  }, [animate]);

  return animate ? frame : 0;
}
