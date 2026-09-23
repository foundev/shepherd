import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { setTomlValue } from "../src/config/write.js";

describe("config writer", () => {
  it("replaces a key in place and keeps comments", () => {
    const text = [
      "# my config",
      "[theme]",
      "# name = \"catppuccin\"",
      "name = \"nord\"",
      "",
      "[ui]",
      "confirm_close = false",
    ].join("\n");
    const next = setTomlValue(text, "theme", "name", "dracula");
    expect(next).toContain("# my config");
    expect(next).toContain("# name = \"catppuccin\"");
    expect(parse(next)).toMatchObject({
      theme: { name: "dracula" },
      ui: { confirm_close: false },
    });
  });

  it("adds missing keys and sections", () => {
    let text = "[ui]\nconfirm_close = false\n";
    text = setTomlValue(text, "ui", "status_indicators", "symbols");
    text = setTomlValue(text, "ui.toast", "delivery", "system");
    text = setTomlValue(setTomlValue("", "ui.sound", "enabled", false), "theme", "name", "nord");
    expect(parse(text)).toEqual({
      ui: { sound: { enabled: false } },
      theme: { name: "nord" },
    });
    const combined = setTomlValue(
      setTomlValue("[ui]\nconfirm_close = false\n", "ui", "status_indicators", "symbols"),
      "ui.toast",
      "delivery",
      "system",
    );
    expect(parse(combined)).toEqual({
      ui: {
        confirm_close: false,
        status_indicators: "symbols",
        toast: { delivery: "system" },
      },
    });
  });
});
