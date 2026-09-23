import { execFile } from "node:child_process";
import os from "node:os";
import { useEffect, useMemo, useState } from "react";
import type { TabBarStatusItem } from "../config/model.js";
import type { Segment } from "./chrome.js";
import { theme } from "./theme.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The strftime subset Shepherd's datetime entry uses. */
export function strftime(format: string, date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const hours12 = date.getHours() % 12 || 12;
  const codes: Record<string, string> = {
    Y: String(date.getFullYear()),
    y: pad(date.getFullYear() % 100),
    m: pad(date.getMonth() + 1),
    d: pad(date.getDate()),
    e: String(date.getDate()).padStart(2, " "),
    H: pad(date.getHours()),
    I: pad(hours12),
    l: String(hours12).padStart(2, " "),
    M: pad(date.getMinutes()),
    S: pad(date.getSeconds()),
    p: date.getHours() < 12 ? "AM" : "PM",
    a: DAYS[date.getDay()] ?? "",
    b: MONTHS[date.getMonth()] ?? "",
    j: pad(Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86_400_000), 3),
    "%": "%",
  };
  return format.replace(/%(.)/g, (match, code: string) => codes[code] ?? match);
}

/** Segments for `ui.tab_bar_right`: refreshed each second, with command
 * entries re-run on their own interval. */
export function useTabBarStatus(
  items: TabBarStatusItem[],
  separator: string,
  zoomed: boolean,
): Segment[] {
  const [now, setNow] = useState(() => new Date());
  const [outputs, setOutputs] = useState<Record<number, string>>({});

  const hasClock = items.some((item) => item.type === "datetime");
  useEffect(() => {
    if (!hasClock) return;
    const timer = setInterval(() => setNow(new Date()), 1_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [hasClock]);

  const commands = useMemo(() => JSON.stringify(items), [items]);
  useEffect(() => {
    const timers: NodeJS.Timeout[] = [];
    items.forEach((item, index) => {
      if (item.type !== "command") return;
      const run = () => {
        execFile(
          "/bin/sh",
          ["-c", item.command],
          { timeout: item.timeout_seconds * 1_000, maxBuffer: 64 * 1024 },
          (error, stdout) => {
            const text = error ? "" : stdout.split("\n")[0]?.trim() ?? "";
            setOutputs((current) => current[index] === text ? current : { ...current, [index]: text });
          },
        );
      };
      run();
      const timer = setInterval(run, item.interval_seconds * 1_000);
      timer.unref?.();
      timers.push(timer);
    });
    return () => timers.forEach((timer) => clearInterval(timer));
    // Re-run only when the configured entries change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commands]);

  const segments: Segment[] = [];
  items.forEach((item, index) => {
    let segment: Segment | null = null;
    const plain = { color: theme.overlay1, backgroundColor: theme.panelBg };
    if (item.type === "zoom") {
      if (zoomed) {
        segment = {
          text: "ZOOM",
          color: theme.panelContrast,
          backgroundColor: theme.brand,
          bold: true,
        };
      }
    } else if (item.type === "hostname") {
      segment = { text: os.hostname().split(".")[0] ?? "", ...plain };
    } else if (item.type === "datetime") {
      segment = { text: strftime(item.format, now), ...plain };
    } else if (item.type === "text") {
      segment = { text: item.text, ...plain };
    } else if (outputs[index]) {
      segment = { text: outputs[index] ?? "", ...plain };
    }
    if (!segment || !segment.text) return;
    if (segments.length > 0) {
      segments.push({ text: separator, color: theme.muted, backgroundColor: theme.panelBg });
    }
    segments.push(segment);
  });
  return segments;
}
