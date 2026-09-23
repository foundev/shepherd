export interface MouseInputEvent {
  button: "left" | "middle" | "right" | "other";
  action: "press" | "release" | "drag" | "move" | "wheel";
  column: number;
  row: number;
  direction?: "up" | "down";
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  /** SGR button code as sent by the host terminal. */
  code: number;
}

export function classifyMouse(
  rawButton: number,
  release: boolean,
  column: number,
  row: number,
): MouseInputEvent {
  const base = rawButton & 3;
  const motion = (rawButton & 32) !== 0;
  const wheel = (rawButton & 64) !== 0;
  const button = base === 0
    ? "left"
    : base === 1
      ? "middle"
      : base === 2
        ? "right"
        : "other";

  return {
    button,
    action: wheel
      ? "wheel"
      : motion
        ? base === 3
          ? "move"
          : "drag"
        : release
          ? "release"
          : "press",
    column,
    row,
    direction: wheel ? (base === 0 ? "up" : "down") : undefined,
    shift: (rawButton & 4) !== 0,
    alt: (rawButton & 8) !== 0,
    ctrl: (rawButton & 16) !== 0,
    code: rawButton,
  };
}
