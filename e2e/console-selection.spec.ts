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

test("Select All takes the whole buffer, not just the mounted rows", async ({ page }) => {
  const log = await consoleOutput(page);
  await page.evaluate(() => {
    (window as unknown as { copied: string[] }).copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => (window as unknown as { copied: string[] }).copied.push(text) },
    });
  });
  await log.focus();
  await page.keyboard.press("Meta+A");
  // Selection stays inside the console: nothing from the workbench behind it is selected.
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected).not.toContain("Project");
  await page.keyboard.press("Meta+C");
  const [copied] = await page.evaluate(() => (window as unknown as { copied: string[] }).copied);
  expect(copied?.split("\n")).toHaveLength(500);
  expect(copied).toContain("output 0\n");
  expect(copied).toMatch(/output 499$/);
});

test("moves a caret with IDEA's console keys instead of scrolling to either end", async ({ page }) => {
  const log = await consoleOutput(page);
  await page.evaluate(() => document.getElementById("splash")?.remove());
  await log.evaluate((el) => {
    el.scrollTop = 200 * 20;
  });
  const row = log.locator('[data-index="205"]');
  await expect(row).toBeVisible();
  const box = (await row.boundingBox())!;
  await page.mouse.click(box.x + 30, box.y + box.height / 2);
  const caret = () =>
    page.evaluate(() => {
      const s = window.getSelection()!;
      const row = (s.focusNode as Node | null)?.parentElement?.closest("[data-index]");
      return { row: Number(row?.getAttribute("data-index")), offset: s.focusOffset, text: s.toString() };
    });
  const top = await log.evaluate((el) => el.scrollTop);
  await page.keyboard.press("End");
  expect(await caret()).toEqual({ row: 205, offset: 10, text: "" });
  expect(await log.evaluate((el) => el.scrollTop)).toBe(top);
  // The arrows (also bound in the Git log) and ⌘← / ⌘→ reach the console through the keymap.
  for (const [key, row, offset] of [
    ["ArrowLeft", 205, 9],
    ["ArrowRight", 205, 10],
    ["ArrowRight", 206, 0],
    ["ArrowLeft", 205, 10],
    ["ArrowUp", 204, 10],
    ["ArrowDown", 205, 10],
    ["Meta+ArrowLeft", 205, 0],
    ["Meta+ArrowRight", 205, 10],
  ] as const) {
    await page.keyboard.press(key);
    expect(await caret(), key).toEqual({ row, offset, text: "" });
  }
  await page.keyboard.press("Shift+Home");
  expect(await caret()).toMatchObject({ row: 205, offset: 0, text: "output 205" });

  // ⇧⌘Home selects to the start without mounting the rows in between; copying takes all of them.
  await page.keyboard.press("End");
  await page.keyboard.press("Meta+Shift+Home");
  await expect.poll(() => log.evaluate((el) => el.scrollTop)).toBe(0);
  expect(await log.locator("[data-index]").count()).toBeLessThan(100);
  await page.evaluate(() => {
    (window as unknown as { copied: string[] }).copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => (window as unknown as { copied: string[] }).copied.push(text) },
    });
  });
  await page.keyboard.press("Meta+C");
  const copied = () => page.evaluate(() => (window as unknown as { copied: string[] }).copied[0] ?? "");
  await expect.poll(copied).toMatch(/^output 0\n[\s\S]*\noutput 205$/);
  expect((await copied()).split("\n")).toHaveLength(206);

  await page.keyboard.press("Meta+End");
  await expect.poll(caret).toEqual({ row: 499, offset: 10, text: "" });
  // PageUp moves the caret a screen up and scrolls the output with it.
  const bottom = await log.evaluate((el) => el.scrollTop);
  await page.keyboard.press("PageUp");
  await expect.poll(async () => (await caret()).row).toBeLessThan(490);
  const { row: paged } = await caret();
  expect(paged).toBeGreaterThan(480);
  await expect.poll(() => log.evaluate((el) => el.scrollTop)).toBe(bottom - (499 - paged) * 20);
});

/** Mount the real console over the given output, wrapped or not. */
async function consoleOf(page: Page, text: string, softWrap: boolean) {
  await page.goto("/");
  await page.evaluate(
    async ({ text, softWrap }) => {
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
      model.append({ kind: "stdout", text });
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;inset:0;z-index:99999;display:flex;height:300px;background:white";
      document.body.append(host);
      function Console() {
        const [following, setFollowing] = useState(false);
        return createElement(ConsoleView, {
          model,
          version: 1,
          softWrap,
          follow: following,
          onFollowChange: setFollowing,
          cwd: "/",
        });
      }
      createRoot(host).render(createElement(Console));
    },
    { text, softWrap },
  );
  const log = page.getByRole("log", { name: "Console", exact: true });
  await expect(log.locator("[data-index]").first()).toBeVisible();
  return log;
}

for (const softWrap of [false, true]) {
  test(`takes a blank output line as a line break, not a zero-width space (soft wrap ${softWrap ? "on" : "off"})`, async ({
    page,
  }) => {
    const log = await consoleOf(page, "first\n\nsecond\n", softWrap);
    // A blank line is still a whole row: stripping the character must not shrink it.
    const heights = await log.evaluate((el) =>
      [...el.querySelectorAll("[data-index]")].map((row) => Math.round(row.getBoundingClientRect().height)),
    );
    expect(heights).toHaveLength(3);
    expect(new Set(heights).size).toBe(1);
    expect(heights[0]).toBeGreaterThan(0);

    const selected = await log.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el.firstElementChild!);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    });
    expect(selected).not.toContain("\u200b");
    // Chromium drops the trailing break of a selection; the blank line in the middle stays one.
    expect(selected.split("\n")).toEqual(["first", "", "second"]);
  });
}
