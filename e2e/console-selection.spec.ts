import { expect, test, type Page } from "@playwright/test";

/** Mount the real console with enough output to recycle rows while selecting. */
async function consoleOutput(page: Page, follow = false) {
  await page.goto("/");
  await page.evaluate(async (follow) => {
    const reactPath = "/node_modules/.vite/deps/react.js";
    const domPath = "/node_modules/.vite/deps/react-dom_client.js";
    const viewPath = "/src/features/run/ConsoleView.tsx";
    const modelPath = "/src/features/run/console.ts";
    const react = await import(reactPath);
    const dom = await import(domPath);
    const { createElement, useState } = react.default ?? react;
    const { createRoot } = dom.default ?? dom;
    const { ConsoleView } = await import(viewPath);
    const { ConsoleModel } = await import(modelPath);
    const model = new ConsoleModel();
    model.append({ kind: "stdout", text: Array.from({ length: 500 }, (_, i) => `output ${i}`).join("\n") });
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;z-index:99999;display:flex;height:300px;background:white";
    document.body.append(host);
    function Console() {
      const [following, setFollowing] = useState(follow);
      return createElement(ConsoleView, {
        model,
        version: 1,
        softWrap: false,
        follow: following,
        onFollowChange: setFollowing,
        cwd: "/",
      });
    }
    createRoot(host).render(createElement(Console));
  }, follow);
  const log = page.getByRole("log", { name: "Console", exact: true });
  await expect(log.locator("[data-index]").first()).toBeVisible();
  return log;
}

test("keeps a console selection intact when scrolling beyond the virtual window", async ({ page }) => {
  const log = await consoleOutput(page);
  await log.evaluate((el) => {
    el.scrollTop = 200 * 20;
  });
  const start = log.locator('[data-index="205"]');
  await expect(start).toBeVisible();
  await start.evaluate((el) => {
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(el.firstChild!.firstChild!, 2, el.nextElementSibling!.firstChild!.firstChild!, 5);
  });
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("tput 205\noutpu");
  await log.evaluate((el) => {
    el.scrollTop = 350 * 20;
  });
  await expect(log.locator('[data-index="350"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("tput 205\noutpu");
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect(start).toHaveCount(0);
});

test("preserves all lines in a drag selection across virtual windows", async ({ page }) => {
  const log = await consoleOutput(page);
  await log.evaluate((el) => {
    el.scrollTop = 200 * 20;
  });
  const start = log.locator('[data-index="205"]');
  await expect(start).toBeVisible();
  const box = (await start.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 30, { steps: 5 });
  await log.evaluate((el) => {
    el.scrollTop = 280 * 20;
  });
  const end = log.locator('[data-index="285"]');
  await expect(end).toBeVisible();
  const endBox = (await end.boundingBox())!;
  await page.mouse.move(endBox.x + 60, endBox.y + 10, { steps: 5 });
  await page.mouse.up();
  const text = await page.evaluate(() => window.getSelection()?.toString());
  expect(text).toContain("output 206\noutput 207");
  expect(text).toContain("output 250\noutput 251");
  expect(text).toContain("output 284");
});
