import { expect, stubDesktop, test } from "./fixtures";

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
    const count = search.locator("[aria-live=polite]");
    await expect(count).toHaveText(/\d+\/3/);
    await expect(count).toHaveCSS("font-size", "13px");
    const match = await count.textContent();
    // The incremental search can report after the first Enter; retry until Enter moves on.
    await expect(async () => {
      await input.press("Enter");
      await expect(count).not.toHaveText(match!, { timeout: 1000 });
    }).toPass();
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
    const matchCase = search.getByRole("button", { name: "Match Case", exact: true });
    const inputBox = (await input.boundingBox())!;
    if (width <= 280 || split) {
      expect(inputBox.width).toBeGreaterThan(bounds.width * 0.62);
      expect((await matchCase.boundingBox())!.y).toBeGreaterThan(inputBox.y + inputBox.height);
    } else {
      expect(inputBox.width).toBeGreaterThan(80);
    }
    const countBox = (await count.boundingBox())!;
    const previousBox = (await search.getByRole("button", { name: "Previous Occurrence", exact: true }).boundingBox())!;
    expect(previousBox.x - countBox.x - countBox.width).toBeLessThanOrEqual(4);
    expect(countBox.y + countBox.height / 2).toBeCloseTo(previousBox.y + previousBox.height / 2, 0);

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
  expect(top.width).toBeLessThan(420);

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

test("terminal composition follows a drawn caret inside the session", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const layout = "/src/workbench/toolwindows/store.ts";
    (await import(layout)).showToolWindow("terminal", true);
  });
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  const textarea = terminal.locator(".xterm-helper-textarea");
  await expect(textarea).toBeFocused();
  await page.evaluate(async () => {
    const module = "/src/features/terminal/runtime.ts";
    const { term } = (await import(module)).activeSession();
    term.reset();
    // Hide the hardware cursor, draw a reverse-video cell at column five, then park at the right edge.
    await new Promise<void>((done) => term.write("\x1b[?25l\x1b[1;5H\x1b[7mX\x1b[0m\x1b[1;999H", done));
  });
  const caret = terminal.locator(".xterm-rows .xterm-bg-257", { hasText: "X" });
  await expect(caret).toBeVisible();
  await expect
    .poll(async () => {
      const [input, drawn] = await Promise.all([textarea.boundingBox(), caret.boundingBox()]);
      return input && drawn && Math.abs(input.x - drawn.x) <= 1 && Math.abs(input.y - drawn.y) <= 1;
    })
    .toBe(true);
});

test("dragging terminal tabs into editor strips and split edges preserves live sessions and scrollback", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const handlers = window.__ipc.handlers;
    let id = 0;
    const killed: number[] = [];
    (window as unknown as { __killedPtys: number[] }).__killedPtys = killed;
    handlers.term_default_shell = () => "/bin/zsh";
    handlers.term_available_shells = () => ["/bin/zsh"];
    handlers.term_spawn = () => ({ id: ++id, title: "zsh", pid: id });
    handlers.term_resize = () => null;
    handlers.term_write = () => null;
    handlers.term_is_busy = () => false;
    handlers.term_kill = (args: unknown) => {
      killed.push((args as { id: number }).id);
      return null;
    };

    const contributions = "/src/workbench/contributions.ts";
    const editor = (await import(contributions)).editorService();
    await editor.openFile("/dev/acme-api/App.tsx", { focus: false });
    await editor.openFile("/dev/acme-api/README.md", { focus: false });
    const store = "/src/workbench/toolwindows/store.ts";
    const layout = await import(store);
    layout.setToolWindowSize("bottom", 240);
    layout.showToolWindow("terminal", true);
  });

  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  await expect(terminal.locator(".xterm-helper-textarea")).toBeFocused();

  // Open a second terminal tab and write distinct output into both sessions.
  await terminal.getByRole("button", { name: "New Tab", exact: true }).click();
  const termStrip = terminal.getByRole("tablist", { name: "Terminal sessions" });
  await expect(termStrip.getByRole("tab")).toHaveCount(2);

  await page.evaluate(async () => {
    const store = "/src/features/terminal/store.ts";
    const rt = await import(store);
    const [first, second] = rt.useTerminals.getState().tabs;
    const s1 = rt.getSession(first!.session)!;
    const s2 = rt.getSession(second!.session)!;
    await new Promise<void>((done) => s1.term.write("ALPHA-SESSION-OUTPUT\r\n", done));
    await new Promise<void>((done) => s2.term.write("BETA-TEST-RUNNER\r\n", done));
  });

  // 1) Drag "Local" into the editor tab strip between App.tsx and README.md.
  const localTab = termStrip.getByRole("tab", { name: "Local", exact: true });
  const readmeTab = page.getByRole("tablist", { name: "Editor tabs" }).getByRole("tab", { name: "README.md" });
  const from1 = (await localTab.boundingBox())!;
  const to1 = (await readmeTab.boundingBox())!;
  await page.mouse.move(from1.x + from1.width / 2, from1.y + from1.height / 2);
  await page.mouse.down();
  await page.mouse.move(to1.x + 6, to1.y + to1.height / 2, { steps: 8 });
  if (process.env.OPENIDEA_TERMINAL_SHOTS)
    await page.screenshot({
      path: `${process.env.OPENIDEA_TERMINAL_SHOTS}/after-strip-hover.png`,
      animations: "disabled",
    });
  await page.mouse.up();

  const editorLists = page.getByRole("tablist", { name: "Editor tabs" });
  await expect(editorLists.first().getByRole("tab")).toHaveText(["App.tsx", "Local", "README.md"]);
  await expect(termStrip.getByRole("tab")).toHaveCount(1);

  const editorArea = page.locator("[data-pane-id]");
  await expect(editorArea.locator(".xterm-rows")).toContainText("ALPHA-SESSION-OUTPUT");
  await expect(editorArea.locator(".xterm-helper-textarea")).toBeFocused();

  // 2) Drag the remaining "Local (2)" onto the right edge of the editor pane to split it, hiding the empty tool window.
  const local2Tab = termStrip.getByRole("tab", { name: "Local (2)", exact: true });
  const paneBox = (await editorArea.first().locator('[role="tabpanel"]').boundingBox())!;
  const from2 = (await local2Tab.boundingBox())!;
  await page.mouse.move(from2.x + from2.width / 2, from2.y + from2.height / 2);
  await page.mouse.down();
  await page.mouse.move(paneBox.x + paneBox.width - 20, paneBox.y + paneBox.height / 2, { steps: 8 });
  if (process.env.OPENIDEA_TERMINAL_SHOTS)
    await page.screenshot({
      path: `${process.env.OPENIDEA_TERMINAL_SHOTS}/after-split-hover.png`,
      animations: "disabled",
    });
  await page.mouse.up();

  await expect(terminal).toBeHidden();
  await expect(editorArea).toHaveCount(2);
  await expect(editorArea.nth(1).locator(".xterm-rows")).toContainText("BETA-TEST-RUNNER");
  await expect(editorArea.nth(1).locator(".xterm-helper-textarea")).toBeFocused();

  // 3) Resize the editor split divider and confirm both panes and the live PTY survive.
  const widthBefore = (await editorArea.nth(1).boundingBox())!.width;
  const divider = page.locator("[data-editor-area]").getByRole("separator");
  const divBox = (await divider.boundingBox())!;
  await page.mouse.move(divBox.x + divBox.width / 2, divBox.y + divBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(divBox.x - 100, divBox.y + divBox.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await editorArea.nth(1).boundingBox())!.width).toBeGreaterThan(widthBefore + 50);
  await expect(editorArea.nth(1).locator(".xterm-rows")).toContainText("BETA-TEST-RUNNER");
  if (process.env.OPENIDEA_TERMINAL_SHOTS)
    await page.screenshot({
      path: `${process.env.OPENIDEA_TERMINAL_SHOTS}/after-final.png`,
      animations: "disabled",
    });
  expect(await page.evaluate(() => (window as unknown as { __killedPtys: number[] }).__killedPtys)).toEqual([]);
});
