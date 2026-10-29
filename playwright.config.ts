/**
 * End-to-end tests in plain-browser mode: Vite serves the UI, the shell injects
 * a sample project and features fall back to in-memory backends (no Tauri, no
 * network). Run with `pnpm e2e`.
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.OPENIDEA_E2E_PORT ?? 1450);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1400, height: 900 },
    trace: "retain-on-failure",
    // The workbench keeps indeterminate progress animations running; screenshots
    // are taken explicitly with `animations: "disabled"` instead.
    screenshot: "off",
    // Closed dialogs and popups leave a fading copy behind (ui/exitGhost.ts); skip it.
    reducedMotion: "reduce",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1400, height: 900 },
        // The specs use the macOS keymap (⌘-shortcuts) on every host OS.
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      },
    },
  ],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
