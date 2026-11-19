// @vitest-environment node
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { Harness } from "./harness.ts";
import { chromiumInstalled } from "./lifecycle.ts";
import { installInPage } from "./inpage.ts";

let server: ViteDevServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let h: Harness;

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("../../", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 },
    optimizeDeps: { entries: ["perf/lib/causality.fixture.ts"] },
    plugins: [
      {
        name: "causality-fixture",
        configureServer(s) {
          s.middlewares.use((req, res, next) => {
            if (req.url !== "/") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              '<div id="editor"></div><input id="other"><div id="result">ready</div><script type="module" src="/perf/lib/causality.fixture.ts"></script>',
            );
          });
        },
      },
    ],
  });
  await server.listen();
  browser = await chromium.launch({ channel: process.env.OPENIDEA_PERF_CHANNEL ?? "chromium" });
}, 30_000);

beforeEach(async () => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto(server.resolvedUrls!.local[0]!);
  await page.waitForFunction(() => "__openideaPerf" in window);
  await page.evaluate(installInPage);
  const cdp = await context.newCDPSession(page);
  h = new Harness(page, cdp);
});
afterEach(async () => {
  await context?.close();
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function mode(name: string) {
  await page.evaluate((name) => {
    const w = window as unknown as { __fixture: Record<string, boolean> };
    w.__fixture[name] = true;
  }, name);
}

async function fixtureFile(text = "start\nend") {
  await h.openFile("/one/Same.ts", text);
  await h.setCursor(0);
}

// Another channel (OPENIDEA_PERF_CHANNEL=chrome) is the installed browser itself.
describe.skipIf(!chromiumInstalled(false) && !process.env.OPENIDEA_PERF_CHANNEL)(
  "current-operation UI measurements",
  () => {
    it("observes startup without input, but rejects pre-existing DOM even after a no-op key", async () => {
      expect(await h.inPage((p) => p.waitShown("#result", "ready", 500))).toBeGreaterThanOrEqual(0);
      await expect(h.measure(async () => {}, "#result", "ready", 80)).rejects.toThrow("timed out");
      await expect(
        h.measure(
          () =>
            page.evaluate(() => {
              document.querySelector("#result")!.textContent = "ready before input";
            }),
          "#result",
          "ready",
          80,
        ),
      ).rejects.toThrow("timed out");
      await expect(
        h.measure(
          async () => {
            await page.evaluate(() => {
              document.querySelector("#result")!.textContent = "ready changed before input";
            });
            await page.keyboard.press("Shift");
          },
          "#result",
          "ready",
          80,
        ),
      ).rejects.toThrow("timed out");
      await expect(h.measure(() => page.keyboard.press("Shift"), "#result", "ready", 80)).rejects.toThrow("timed out");
    });

    it("waits for input and the resulting target change, not an earlier frame", async () => {
      let changedAt = 0;
      const result = h.measure(
        async () => {
          await h.inPage((p) => p.afterNextPaint());
          await page.keyboard.press("a");
          await h.inPage((p) => p.afterNextPaint());
          changedAt = await page.evaluate(() => {
            document.querySelector("#result")!.textContent = "ready now";
            return performance.now();
          });
        },
        "#result",
        "ready",
        1_000,
      );
      const latency = await result;
      expect((await h.inPage((p) => p.lastInput)) + latency).toBeGreaterThanOrEqual(changedAt);
    });

    it("propagates trigger failure and cancels its waiter without browser rejection", async () => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await expect(
        h.measure(
          async () => {
            throw new Error("trigger failed");
          },
          "#missing",
          null,
          80,
        ),
      ).rejects.toThrow("trigger failed");
      await expect(h.measure(async () => false, "#missing", null, 80)).rejects.toThrow("returned false");
      await h.inPage(async (p) => {
        await p.afterNextPaint();
        await p.afterNextPaint();
      });
      expect(errors).toEqual([]);
      expect(await h.inPage((p) => p.waitShown("#result", "ready", 80))).toBeGreaterThanOrEqual(0);
    });

    it.each(["ignoreOpen", "wrongContents"])(
      "requires the requested path and seeded contents with %s",
      async (fault) => {
        await fixtureFile();
        await mode(fault);
        await expect(h.openFile("/two/Same.ts", "different", 100)).rejects.toThrow("requested editor");
      },
    );

    it("does not finish before the open action succeeds, even with matching existing contents", async () => {
      await fixtureFile();
      await mode("delayOpen");
      let completed = false;
      const opening = h.openFile("/one/Same.ts", "start\nend").finally(() => {
        completed = true;
      });
      await page.waitForFunction(() => "__releaseOpen" in window);
      try {
        await h.inPage((p) => p.afterNextPaint());
        expect(completed).toBe(false);
      } finally {
        await page.evaluate(() => {
          if (!("__releaseOpen" in window) || typeof window.__releaseOpen !== "function")
            throw new Error("open action was not held");
          window.__releaseOpen();
        });
        await opening;
      }
    });

    it("awaits the open action and rejects failed actions even with a matching editor", async () => {
      await fixtureFile();
      await mode("rejectOpen");
      await expect(h.openFile("/one/Same.ts")).rejects.toThrow("open failed");
    });

    it("measures real typing, including automatic brackets, indentation and backspace", async () => {
      await fixtureFile("function f() {\n}\n");
      await h.setCursor(14);
      expect(await h.typeMeasured("const n = (1 + 2);\n\b", 0)).toHaveLength(20);
    });

    it.each(["swallowTyping", "wrongCaret", "missingSample", "wrongFocus"])("rejects typing with %s", async (fault) => {
      await fixtureFile();
      if (fault === "wrongFocus") await page.locator("#other").click();
      else await mode(fault);
      await expect(h.typeMeasured("x", 0)).rejects.toThrow(/typing|caret|sample|focus/);
    });

    it("checks the whole document after bounded per-key observations", async () => {
      await fixtureFile("start\n" + "unchanged\n".repeat(200) + "end");
      expect(await h.typeMeasured("ok", 0)).toHaveLength(2);
      await mode("mutateDistant");
      await expect(h.typeMeasured("x", 0)).rejects.toThrow("outside the intended insertion");
    });

    it("requires both cursor destination and viewport displacement for the jump", async () => {
      await fixtureFile(Array.from({ length: 1_000 }, (_, i) => `export class Repository${i} {}`).join("\n"));
      await mode("disableJump");
      await expect(h.jumpToEnd(100)).rejects.toThrow("timed out");
      await page.evaluate(() => {
        const w = window as unknown as { __fixture: Record<string, boolean> };
        w.__fixture.disableJump = false;
      });
      expect(await h.jumpToEnd(1_000)).toBeGreaterThanOrEqual(0);
      expect((await h.editorState())!.head).toBe((await h.editorState())!.length);
    });

    it("requires each completion arrow to advance exactly one selected item", async () => {
      await fixtureFile("");
      await h.measure(() => page.keyboard.press("g"), ".cm-tooltip-autocomplete li", "getOrder", 2_000);
      await page.waitForSelector('.cm-tooltip-autocomplete li[aria-selected="true"]');
      expect(await h.completionArrowsMeasured(3, 0)).toHaveLength(3);
      await mode("disableArrows");
      await expect(h.completionArrowsMeasured(1, 0)).rejects.toThrow("completion selection");
    });
  },
);
