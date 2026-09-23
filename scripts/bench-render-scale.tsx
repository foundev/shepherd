import React from "react";
import { Box } from "ink";
import { render } from "ink-testing-library";
import { TerminalPane } from "../src/client/TerminalPane.js";
import { layoutGeometry, splitPane } from "../src/server/layout.js";
import { unwrapTerminalLines } from "../src/server/terminal.js";
import type { LayoutNode, PaneView, TerminalLine } from "../src/types.js";

const CARDINALITIES = [1, 15, 50] as const;

interface Sample {
  panes: number;
  medianUs: number;
  p95Us: number;
  maxUs: number;
}

function pane(id: string): PaneView {
  return {
    id,
    title: `agent-${id}`,
    command: "claude",
    cwd: "/tmp",
    agent: "claude",
    status: id.charCodeAt(1) % 2 === 0 ? "working" : "blocked",
    exitCode: null,
    updatedAt: "2026-09-23T00:00:00.000Z",
  };
}

function lines(): TerminalLine[] {
  return Array.from({ length: 8 }, (_, row) => [{
    text: `pane ${row} `.repeat(4).trim(),
    color: row % 2 === 0 ? "#c0caf5" : "#7aa2f7",
  }]);
}

function layout(count: number): LayoutNode {
  let node: LayoutNode = { kind: "pane", paneId: "p0" };
  for (let index = 1; index < count; index += 1) {
    node = splitPane(
      node,
      `p${index - 1}`,
      `p${index}`,
      index % 2 === 0 ? "down" : "right",
      0.5,
    );
  }
  return node;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.floor((sorted.length - 1) * fraction),
  );
  return sorted[index] ?? 0;
}

function benchmarkRender(count: number): Sample {
  const panes = Array.from(
    { length: count },
    (_, index) => pane(`p${index}`),
  );
  const content = lines();
  const width = 180;
  const tileWidth = Math.max(20, Math.floor(width / 5));
  const element = (
    <Box width={width} height={50} flexWrap="wrap">
      {panes.map((paneView) => (
        <TerminalPane
          key={paneView.id}
          pane={paneView}
          focused={paneView.id === "p0"}
          width={tileWidth}
          height={10}
          lines={content}
        />
      ))}
    </Box>
  );

  const durations: number[] = [];
  for (let index = 0; index < 7; index += 1) {
    const instance = render(element);
    const started = process.hrtime.bigint();
    instance.rerender(element);
    const stopped = process.hrtime.bigint();
    durations.push(Number(stopped - started) / 1_000);
    instance.unmount();
  }

  return {
    panes: count,
    medianUs: percentile(durations, 0.5),
    p95Us: percentile(durations, 0.95),
    maxUs: Math.max(...durations),
  };
}

function benchmarkModel(count: number): number {
  const node = layout(count);
  const started = process.hrtime.bigint();
  const geometries = layoutGeometry(node, {
    x: 0,
    y: 0,
    width: 180,
    height: 50,
  });
  const unwrapped = unwrapTerminalLines(
    Array.from({ length: count }, () => [{ text: "wrapped ".repeat(12) }]),
    Array.from({ length: count }, (_, index) => index > 0),
  );
  const stopped = process.hrtime.bigint();
  if (geometries.length !== count || unwrapped.length === 0) {
    throw new Error("render-scale fixture lost panes");
  }
  return Number(stopped - started) / 1_000;
}

console.log("Shepherd render scaling profile");
console.log("  panes  model_us  render_median_us  render_p95_us  render_max_us");
for (const count of CARDINALITIES) {
  const modelUs = benchmarkModel(count);
  const renderSample = benchmarkRender(count);
  console.log(
    `  ${String(count).padStart(5)} ${modelUs.toFixed(0).padStart(8)} ` +
    `${renderSample.medianUs.toFixed(0).padStart(16)} ` +
    `${renderSample.p95Us.toFixed(0).padStart(14)} ` +
    `${renderSample.maxUs.toFixed(0).padStart(13)}`,
  );
}
