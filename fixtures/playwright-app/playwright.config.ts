import { defineConfig } from "@playwright/test";

// The IDE replaces the reporter with `list` for its test tree; `dot` is what a terminal shows.
export default defineConfig({
  testDir: "tests",
  reporter: "dot",
});
