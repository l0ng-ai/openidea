// @vitest-environment node
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromiumInstalled } from "../../perf/lib/lifecycle.ts";
import { track } from "./measure.ts";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
beforeEach(async () => {
  page = await browser.newPage();
  await page.setContent('<div role="dialog">Previous dialog</div><div id="result">Previous result</div>');
  await page.evaluate(() => {
    Object.assign(window, {
      __openideaPerf: {
        editorState: () => null,
        runAction: async () => false,
      },
    });
  });
});
afterEach(async () => {
  await page.close();
});
afterAll(async () => {
  await browser.close();
});

const existingResult = () => document.querySelector("#result") !== null;

describe.skipIf(!chromiumInstalled(true))("tracking the current action", () => {
  it("rejects an action that declines to run even with an old result visible", async () => {
    await expect(
      track(page, { action: "unavailable", arg: null, first: existingResult, done: existingResult, timeoutMs: 1000 }),
    ).rejects.toThrow(/did not run/);
  });

  it("cannot report success before an asynchronous action later rejects", async () => {
    await expect(
      track(page, {
        // Real browser frames exercise ordering against track's rAF observer; no elapsed-time guess.
        run: () =>
          new Promise((_, reject) => {
            requestAnimationFrame(() => requestAnimationFrame(() => reject(new Error("operation failed"))));
          }),
        arg: null,
        first: existingResult,
        done: existingResult,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("operation failed");
  });

  it("waits for successful action completion and observes its current result", async () => {
    const timing = await track(page, {
      run: () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            document.querySelector("#result")!.textContent = "Current result";
            requestAnimationFrame(() => {
              document.querySelector("#result")!.setAttribute("data-completed", "true");
              resolve();
            });
          });
        }),
      arg: null,
      first: () => document.querySelector("#result")?.textContent === "Current result",
      done: () => document.querySelector("#result")?.textContent === "Current result",
      timeoutMs: 1000,
    });
    expect(await page.locator("#result").textContent()).toBe("Current result");
    expect(timing.completeMs).toBeGreaterThanOrEqual(timing.firstResultMs);
    expect(timing.feedbackMs).toBeGreaterThanOrEqual(timing.firstResultMs);
    expect(await page.locator("#result").getAttribute("data-completed")).toBe("true");
  });
});
