// @vitest-environment node
import { expect, test } from "vitest";
import { chromiumInstalled, launchBrowser } from "../../perf/lib/lifecycle.ts";
import { track } from "./measure.ts";

test.skipIf(!chromiumInstalled(true))(
  "track times out on Node's clock when animation frames stop",
  { timeout: 20_000 },
  async () => {
    const runtime = await launchBrowser({ headless: true });
    try {
      const page = await runtime.browser.newPage();
      await page.evaluate(() => {
        // Install the otherwise undeclared probe consumed by the serialized measurement.
        const w = window as unknown as { __openideaPerf: unknown };
        w.__openideaPerf = {
          editorState: () => null,
          runAction: async () => true,
        };
        window.requestAnimationFrame = () => 0;
      });
      // The platform-clock boundary is the regression; a fake Node clock cannot drive Chromium.
      await expect(
        track(page, { action: "fixture.action", arg: null, first: () => false, done: () => false, timeoutMs: 20 }),
      ).rejects.toThrow("page measurement timed out");
    } finally {
      await runtime.close();
    }
  },
);
