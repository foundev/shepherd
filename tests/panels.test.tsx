import { Box, Text, renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { Panel } from "../src/client/panels.js";
import { configureTerminalColors } from "../src/client/colors.js";
import { applyTheme } from "../src/client/theme.js";

describe("panel title colors", () => {
  it.each(["terminal", "custom"])("keeps default text independent from the border foreground in %s palettes", (palette) => {
    const restore = configureTerminalColors({ isTTY: true }, { FORCE_COLOR: "3" });
    try {
      applyTheme(palette === "terminal" ? "terminal" : "shepherd",
        palette === "custom" ? { text: "default", surface1: "gray" } : {});
      const [title] = renderToString(
        <Box width={20} height={4}>
          <Panel rect={{ x: 0, y: 0, width: 20, height: 4 }} title="Settings">
            <Text>Content</Text>
          </Panel>
        </Box>, { columns: 20 },
      ).split("\n");
      // The gray border must reset its foreground before the default-colored
      // title. Otherwise Ink inherits gray for the nested title as well.
      expect(title).toMatch(/\x1b\[90m╭\x1b\[39m(?:\x1b\[[\d;]+m)* Settings /u);
      if (palette === "terminal") expect(title).not.toContain("\x1b[100m");
    } finally {
      restore();
      applyTheme("shepherd");
    }
  });
});
