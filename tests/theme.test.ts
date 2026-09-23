import { describe, expect, it } from "vitest";
import {
  applyTheme,
  canonicalThemeName,
  parseColor,
  statusColor,
  theme,
} from "../src/client/theme.js";
import { PALETTES } from "../src/client/palettes.js";
import { renderWindowTitle } from "../src/client/App.js";
import { configuredShell } from "../src/server/terminal.js";

describe("themes", () => {
  it("ships Shepherd's themes and aliases", () => {
    expect(Object.keys(PALETTES)).toHaveLength(9);
    expect(canonicalThemeName("Shepherd Day")).toBe("shepherd-day");
    expect(canonicalThemeName("Midnight")).toBe("midnight");
    expect(canonicalThemeName("dawn")).toBe("parchment");
    expect(canonicalThemeName("unknown")).toBeNull();
  });

  it("parses Shepherd color syntax", () => {
    expect(parseColor("#FF0080")).toBe("#ff0080");
    expect(parseColor("#f08")).toBe("#ff0088");
    expect(parseColor("rgb(255, 85, 85)")).toBe("#ff5555");
    expect(parseColor("reset")).toBeNull();
    expect(parseColor("lightblue")).toBe("blueBright");
    expect(parseColor("sparkly")).toBeUndefined();
  });

  it("applies palettes, overrides and status colours", () => {
    expect(applyTheme("ember", { red: "#123456" }, "#abcdef")).toEqual([]);
    expect(theme.brand).toBe("#abcdef");
    expect(theme.danger).toBe("#123456");
    expect(theme.background).toBe(PALETTES.ember?.panel_bg);
    expect(statusColor.blocked).toBe("#123456");
    expect(statusColor.working).toBe(PALETTES.ember?.yellow);

    expect(applyTheme("nope", { glitter: "#fff", red: "???" })).toEqual([
      "unknown theme name theme.name = \"nope\"; using \"shepherd\"",
      "theme.custom.glitter: unknown colour token",
      "theme.custom.red: cannot parse colour \"???\"",
    ]);
    expect(theme.brand).toBe(PALETTES.shepherd?.accent);

    applyTheme("terminal");
    expect(theme.background).toBeUndefined();
    applyTheme("shepherd");
  });
});

describe("window title", () => {
  it("fills Shepherd's tokens and escapes braces", () => {
    expect(renderWindowTitle("{hostname}: {workspace} {{x}} {unknown}", {
      hostname: "box",
      workspace: "api",
    })).toBe("box: api {x} {unknown}");
    expect(renderWindowTitle("", { workspace: "api" })).toBe("");
  });
});

describe("shell selection", () => {
  it("follows default_shell and shell_mode", () => {
    expect(configuredShell("", "auto", { SHELL: "/bin/zsh" }, "darwin"))
      .toEqual({ file: "/bin/zsh", args: ["-l"] });
    expect(configuredShell("", "auto", { SHELL: "/bin/zsh" }, "linux"))
      .toEqual({ file: "/bin/zsh", args: [] });
    expect(configuredShell("/usr/bin/fish", "login", {}, "linux"))
      .toEqual({ file: "/usr/bin/fish", args: ["-l"] });
    expect(configuredShell("", "non_login", {}, "darwin"))
      .toEqual({ file: "/bin/sh", args: [] });
  });
});
