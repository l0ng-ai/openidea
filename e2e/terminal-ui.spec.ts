import { expect, test } from "./fixtures";

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
