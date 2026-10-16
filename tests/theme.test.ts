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
import { configuredShell, cwdFromOsc7, paneShell } from "../src/server/terminal.js";

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

  it("honors an explicit Windows default_shell but not a POSIX path or $SHELL", () => {
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
    expect(configuredShell(bash, "auto", {}, "win32")).toEqual({ file: bash, args: [] });
    expect(configuredShell(bash, "login", {}, "win32")).toEqual({ file: bash, args: ["-l"] });
    expect(configuredShell("C:\\Windows\\System32\\cmd.exe", "login", {}, "win32"))
      .toEqual({ file: "C:\\Windows\\System32\\cmd.exe", args: [] });
    expect(configuredShell("pwsh.exe", "auto", {}, "win32")).toEqual({ file: "pwsh.exe", args: ["-NoLogo"] });
    expect(configuredShell("/bin/zsh", "auto", { SHELL: "/usr/bin/bash" }, "win32").file).not.toBe("/bin/zsh");
    expect(configuredShell("", "auto", { SHELL: "/usr/bin/bash" }, "win32").file).not.toBe("/usr/bin/bash");
  });

  it("runs a pane command with the shell's own command flag", () => {
    expect(paneShell("exit 3", { file: "/bin/sh", args: ["-l"] }, "linux"))
      .toEqual({ file: "/bin/sh", args: ["-l", "-c", "exit 3"] });
    expect(paneShell("exit 3", { file: "C:\\Git\\bin\\bash.exe", args: [] }, "win32"))
      .toEqual({ file: "C:\\Git\\bin\\bash.exe", args: ["-c", "exit 3"] });
    expect(paneShell('echo "a b"', { file: "C:\\Windows\\System32\\CMD.EXE", args: [] }, "win32"))
      .toEqual({ file: "C:\\Windows\\System32\\CMD.EXE", args: '/d /s /c "echo "a b""' });
    expect(paneShell("Get-Date", { file: "powershell.exe", args: ["-NoLogo"] }, "win32"))
      .toEqual({ file: "powershell.exe", args: ["-NoLogo", "-Command", "Get-Date"] });
    expect(paneShell(null, { file: "cmd.exe", args: [] }, "win32")).toEqual({ file: "cmd.exe", args: [] });
  });

  it("reads Windows drive paths from OSC 7 file URLs on Windows", () => {
    expect(cwdFromOsc7("file://host/C:/Users/me/some%20dir", "win32")).toBe("C:\\Users\\me\\some dir");
    expect(cwdFromOsc7("file://host/C:/", "win32")).toBe("C:\\");
    expect(cwdFromOsc7("file://host/C:/Users/me", "linux")).toBe("/C:/Users/me");
  });
});
