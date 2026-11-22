import { expect, test } from "./fixtures";

test("terminal output menu groups session, clipboard and split actions and opens Find", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const path = "/src/workbench/toolwindows/store.ts";
    const layout = await import(path);
    layout.moveToolWindow("terminal", "right");
    layout.showToolWindow("terminal", true);
    layout.setToolWindowSize("right", 220);
  });
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  const output = terminal.getByRole("tabpanel").locator(".xterm");
  await expect(terminal.locator(".xterm-helper-textarea")).toBeFocused();
  await output.click({ button: "right", position: { x: 25, y: 50 } });
  const menu = page.getByRole("menu", { name: "Context menu" });
  const find = menu.getByRole("menuitem", { name: /^Find in Terminal/ });
  await expect(find).toBeEnabled();
  const rows = menu.locator(':scope > [role="separator"], :scope > [role="menuitem"]');
  await expect(rows).toHaveText([
    /^Find in Terminal/,
    /^New Terminal Tab/,
    "Restart Session",
    "Close Session",
    "",
    /^Copy/,
    /^Paste/,
    "Select All",
    "",
    /^Clear Buffer/,
    "",
    "Split Right",
    "Split Down",
  ]);
  await expect(menu.getByRole("menuitem", { name: /^Copy/ })).toBeDisabled();
  await find.press("Enter");
  const field = terminal.getByRole("textbox", { name: "Find in terminal" });
  await expect(menu).toBeHidden();
  await expect(field).toBeFocused();
  await field.press("Escape");
  await expect(terminal.locator(".xterm-helper-textarea")).toBeFocused();
});

for (const { width, split } of [{ width: 220 }, { width: 280 }, { width: 520 }, { width: 520, split: true }]) {
  test(`terminal search fits a ${width}px ${split ? "split" : "panel"} and its buttons work from the keyboard`, async ({
    workbench: page,
  }) => {
    await page.evaluate(async (width) => {
      const path = "/src/workbench/toolwindows/store.ts";
      const layout = await import(path);
      layout.moveToolWindow("terminal", "right");
      layout.setToolWindowSize("right", width);
      layout.showToolWindow("terminal", true);
    }, width);
    const terminal = page.getByRole("region", { name: "Terminal", exact: true });
    await expect(terminal.locator(".xterm-helper-textarea")).toBeFocused();
    if (split) {
      await page.evaluate(async () => {
        const path = "/src/platform/actions.ts";
        const { executeAction } = await import(path);
        await executeAction("terminal.splitRight");
      });
      await expect(terminal.getByRole("tablist", { name: "Terminal sessions" })).toHaveCount(2);
      await expect(terminal.locator(".xterm-helper-textarea:focus")).toHaveCount(1);
    }
    await page.evaluate(async () => {
      const path = "/src/features/terminal/runtime.ts";
      const { activeSession } = await import(path);
      await new Promise<void>((resolve) => activeSession().term.write("\r\nalpha ALPHA alpha\r\n", resolve));
    });
    await page.keyboard.press("Meta+f");
    const search = terminal.getByRole("search", { name: "Find in terminal" });
    const input = search.getByRole("textbox", { name: "Find in terminal" });
    await input.fill("alpha");
    await expect(search.locator("[aria-live=polite]")).toHaveText(/\d+\/3/);
    if (process.env.OPENIDEA_TERMINAL_SHOTS)
      await terminal.screenshot({
        path: `${process.env.OPENIDEA_TERMINAL_SHOTS}/terminal-${width}${split ? "-split" : ""}.png`,
      });

    const bounds = (await search.boundingBox())!;
    for (const control of await search.locator("input, button, [aria-live]").all()) {
      const rect = (await control.boundingBox())!;
      expect(rect.x).toBeGreaterThanOrEqual(bounds.x);
      expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    }
    expect((await input.boundingBox())!.width).toBeGreaterThan(40);

    const matchCase = search.getByRole("button", { name: "Match Case", exact: true });
    await matchCase.focus();
    await page.keyboard.press("Enter");
    await expect(matchCase).toHaveAttribute("aria-pressed", "true");
    await expect(search.locator("[aria-live=polite]")).toHaveText(/\d+\/2/);
    await input.fill("missing");
    await expect(search.locator("[aria-live=polite]")).toHaveText("0 results");
    await expect(search.getByRole("button", { name: "Next Occurrence", exact: true })).toBeDisabled();
    await search.getByRole("button", { name: "Close", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(search).toBeHidden();
    await expect(terminal.locator(".xterm-helper-textarea:focus")).toHaveCount(1);
  });
}

test("wide terminal search leaves the grid in place and avoids covering the active match", async ({
  workbench: page,
}) => {
  await page.evaluate(async () => {
    const path = "/src/workbench/toolwindows/store.ts";
    const layout = await import(path);
    layout.setToolWindowSize("bottom", 280);
    layout.showToolWindow("terminal", true);
  });
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  await expect(terminal.locator(".xterm-helper-textarea")).toBeFocused();
  const panel = terminal.getByRole("tabpanel");
  const before = (await panel.boundingBox())!;
  await page.evaluate(async () => {
    const path = "/src/features/terminal/runtime.ts";
    const { activeSession } = await import(path);
    const { term } = activeSession();
    await new Promise<void>((resolve) =>
      term.write(`\x1b[2J\x1b[1;${term.cols - 16}Hright-edge\x1b[1;2Hleft-side\x1b[6;1H`, resolve),
    );
  });

  await page.keyboard.press("Meta+f");
  const search = terminal.getByRole("search", { name: "Find in terminal" });
  const input = search.getByRole("textbox", { name: "Find in terminal" });
  await expect(input).toBeFocused();
  expect(await panel.boundingBox()).toEqual(before);
  const top = (await search.boundingBox())!;
  expect(top.y).toBeCloseTo(before.y, 0);
  expect(top.x + top.width).toBeCloseTo(before.x + before.width, 0);
  expect(top.width).toBeLessThan(before.width);

  await input.fill("right-edge");
  await expect(search.locator("[aria-live=polite]")).toHaveText("1/1");
  await expect
    .poll(async () => {
      const box = (await search.boundingBox())!;
      return box.y + box.height;
    })
    .toBeCloseTo(before.y + before.height, 0);
  await expect(input).toBeFocused();
  expect(await panel.boundingBox()).toEqual(before);

  await input.fill("left-side");
  await expect(search.locator("[aria-live=polite]")).toHaveText("1/1");
  await expect.poll(async () => (await search.boundingBox())!.y).toBeCloseTo(before.y, 0);

  await page.evaluate(async () => {
    const path = "/src/workbench/toolwindows/store.ts";
    const { setToolWindowSize } = await import(path);
    setToolWindowSize("bottom", 130);
  });
  await expect
    .poll(async () => {
      const box = (await search.boundingBox())!;
      return box.y + box.height - (await panel.boundingBox())!.y;
    })
    .toBeCloseTo(0, 0);
  await expect(input).toHaveValue("left-side");
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();
  await expect(terminal.locator(".xterm-helper-textarea")).toBeFocused();
});

test("terminal highlights visible occurrences of selected text in a single overlay layer", async ({
  workbench: page,
}) => {
  await page.evaluate(async () => {
    const path = "/src/workbench/toolwindows/store.ts";
    const layout = await import(path);
    layout.showToolWindow("terminal", true);
  });
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  await expect(terminal.locator(".xterm-helper-textarea")).toBeFocused();

  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(r));
    const path = "/src/features/terminal/runtime.ts";
    const { activeSession } = await import(path);
    const s = activeSession()!;
    s.term.reset();
    await new Promise<void>((resolve) => s.term.write("needle other needle\r\nneedle gamma gamma\r\n", resolve));
    s.term.select(0, 0, 6);
  });

  await expect(terminal.locator(".openidea-terminal-selection-matches")).toHaveCount(1);
  await expect(terminal.locator(".openidea-terminal-selection-match:visible")).toHaveCount(2);
  if (process.env.OPENIDEA_TERMINAL_SHOTS)
    await terminal.screenshot({ path: `${process.env.OPENIDEA_TERMINAL_SHOTS}/terminal-selection-matches.png` });

  await page.evaluate(async () => {
    const path = "/src/features/terminal/runtime.ts";
    const { activeSession } = await import(path);
    activeSession()!.term.clearSelection();
  });
  await expect(terminal.locator(".openidea-terminal-selection-match:visible")).toHaveCount(0);

  // Full-scrollback trim shifts a visible match into the cached margin row above viewportY; scrolling up must highlight it.
  await page.evaluate(async () => {
    const path = "/src/features/terminal/runtime.ts";
    const { activeSession } = await import(path);
    const s = activeSession()!;
    const rows = s.term.rows;
    s.term.options.scrollback = 4;
    s.term.reset();
    const total = rows + 4;
    let payload = "";
    for (let i = 0; i < total - 1; i++) {
      payload += `${i === 4 ? "needle hit" : `row-${i}`}\r\n`;
    }
    payload += "needle sel";
    await new Promise<void>((resolve) => s.term.write(payload, resolve));
    s.term.select(0, total - 1, 6);
  });
  await expect(terminal.locator(".openidea-terminal-selection-match:visible")).toHaveCount(1);

  await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 100));
    const path = "/src/features/terminal/runtime.ts";
    const { activeSession } = await import(path);
    const s = activeSession()!;
    await new Promise<void>((resolve) => s.term.write("\r\nnext", resolve));
    s.term.scrollLines(-1);
  });
  await expect(terminal.locator(".openidea-terminal-selection-match:visible")).toHaveCount(1);
  await expect(terminal.locator(".openidea-terminal-selection-match:visible")).toHaveCSS("top", "0px");
});

test("terminal ⌘F highlights active/inactive search matches and seeds with a new selection", async ({
  workbench: page,
}) => {
  await page.evaluate(async () => {
    const path = "/src/workbench/toolwindows/store.ts";
    const layout = await import(path);
    layout.showToolWindow("terminal", true);
  });
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  await expect(terminal.locator(".xterm-helper-textarea")).toBeFocused();

  await page.evaluate(async () => {
    const path = "/src/features/terminal/runtime.ts";
    const { activeSession } = await import(path);
    const s = activeSession()!;
    s.term.reset();
    await new Promise<void>((resolve) => s.term.write("needle other needle\r\nneedle gamma gamma\r\n", resolve));
    s.term.select(0, 0, 6);
  });

  // Pressing ⌘F seeds the Find bar with "needle" and highlights all 3 matches + 1 active top-layer match.
  await page.keyboard.press("Meta+f");
  const search = terminal.getByRole("search", { name: "Find in terminal" });
  const input = search.getByRole("textbox", { name: "Find in terminal" });
  await expect(input).toHaveValue("needle");
  await expect(search.locator("[aria-live=polite]")).toHaveText(/\d+\/3/);
  await expect(terminal.locator(".xterm-find-active-result-decoration")).toHaveCount(1);
  await expect(terminal.locator(".xterm-rows .xterm-decoration-top")).not.toHaveCount(0);
  await expect(terminal.locator(".openidea-terminal-selection-match:visible")).toHaveCount(0);
  if (process.env.OPENIDEA_TERMINAL_SHOTS)
    await terminal.screenshot({ path: `${process.env.OPENIDEA_TERMINAL_SHOTS}/terminal-search-matches.png` });

  // Selecting a new word ("gamma") while Find is open and pressing ⌘F seeds the Find bar with it.
  await page.evaluate(async () => {
    const path = "/src/features/terminal/runtime.ts";
    const { activeSession } = await import(path);
    activeSession()!.term.select(7, 1, 5);
  });
  await page.keyboard.press("Meta+f");
  await expect(input).toHaveValue("gamma");
  await expect(search.locator("[aria-live=polite]")).toHaveText(/\d+\/2/);
});

test("terminal shows URLs in the link colour with an underline without hovering, in light and dark themes", async ({
  workbench: page,
}) => {
  await page.evaluate(async () => {
    const path = "/src/workbench/toolwindows/store.ts";
    const layout = await import(path);
    layout.showToolWindow("terminal", true);
  });
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  await expect(terminal.locator(".xterm-helper-textarea")).toBeFocused();
  await page.evaluate(async () => {
    const path = "/src/features/terminal/runtime.ts";
    const { activeSession } = await import(path);
    const s = activeSession()!;
    s.term.reset();
    await new Promise<void>((resolve) =>
      s.term.write(
        "  ➜  Local:   http://localhost:5173/\r\n文档 https://example.com/docs 和 https://example.org/a\r\nno link\r\n",
        resolve,
      ),
    );
  });
  const links = terminal.locator(".openidea-terminal-link");
  await expect(links).toHaveCount(3);

  for (const theme of ["light", "dark"]) {
    const link = await page.evaluate(async (theme) => {
      const path = "/src/workbench/theme.ts";
      const { setTheme } = await import(path);
      await setTheme(theme);
      const probe = document.createElement("span");
      probe.style.color = "var(--link)";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    // The underline and the recoloured text both follow the theme's `--link`.
    await expect(links.first()).toHaveCSS("border-bottom-color", link);
    await expect(terminal.locator(".xterm-rows span", { hasText: /^h$/ }).first()).toHaveCSS("color", link);
    if (process.env.OPENIDEA_TERMINAL_SHOTS)
      await terminal.screenshot({ path: `${process.env.OPENIDEA_TERMINAL_SHOTS}/terminal-links-${theme}.png` });
  }
});
