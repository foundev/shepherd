import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent worktrees under .claude/ hold other checkouts of this repo.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
