// @vitest-environment node
import { expect, test, vi } from "vitest";
import { chromiumInstalled, launchBrowser, withDeadline } from "./lifecycle.ts";

test("a deadline rejects an unanswered operation and releases its timer", async () => {
  vi.useFakeTimers();
  try {
    const pending = withDeadline(Promise.withResolvers<void>().promise, 20, "RPC");
    const assertion = expect(pending).rejects.toThrow("RPC timed out after 20 ms");
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test.skipIf(!chromiumInstalled(true)).each(["blocked renderer", "missing animation frames"])(
  "Node deadline survives %s and browser cleanup terminates it",
  { timeout: 20_000 },
  async (mode) => {
    const runtime = await launchBrowser({ headless: true });
    try {
      const page = await runtime.browser.newPage();
      // Real renderer/Node clocks are the boundary under test; fake timers cannot drive Chromium.
      const operation =
        mode === "blocked renderer"
          ? page.evaluate(() => {
              for (;;) {
                /* Deliberately unresponsive renderer. */
              }
            })
          : page.evaluate(() => {
              window.requestAnimationFrame = () => 0;
              return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            });
      await expect(withDeadline(operation, 30, mode)).rejects.toThrow("wall clock");
    } finally {
      await runtime.close();
    }
  },
);
