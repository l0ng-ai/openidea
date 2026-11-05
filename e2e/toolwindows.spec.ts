import { expect, ipcCalls, stubDesktop, test, visibleToolWindows } from "./fixtures";

test("⌘1 focuses, hides and re-shows the Project tool window", async ({ workbench: page }) => {
  const project = page.getByRole("region", { name: "Project" });
  await page.keyboard.press("Meta+1");
  await expect(page.getByRole("tree", { name: "Project" })).toBeFocused();
  await page.keyboard.press("Meta+1");
  await expect(project).toBeHidden();
  await page.keyboard.press("Meta+1");
  await expect(project).toBeVisible();
});

test("⌘4 toggles Run; Shift+Escape hides the active tool window", async ({ workbench: page }) => {
  const run = page.getByRole("region", { name: "Run" });
  await page.keyboard.press("Meta+4");
  await expect(run).toBeVisible();
  await page.keyboard.press("Meta+4");
  await expect(run).toBeHidden();
  await page.keyboard.press("Meta+4");
  await expect(run).toBeVisible();
  await page.keyboard.press("Shift+Escape");
  await expect(run).toBeHidden();
});

test("⌥F12 opens the Terminal tool window and toggles it closed", async ({ workbench: page }) => {
  const terminal = page.getByRole("region", { name: "Terminal" });
  await page.keyboard.press("Alt+F12");
  await expect(terminal).toBeVisible();
  expect(await visibleToolWindows(page)).toContain("Terminal");
  await page.keyboard.press("Alt+F12");
  await expect(terminal).toBeHidden();
});

test("the first ⌥F12 focuses the terminal input once the lazily loaded view mounts", async ({ workbench: page }) => {
  await page.keyboard.press("Alt+F12");
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  await expect(terminal.getByRole("textbox", { name: "Terminal input" })).toBeFocused();
  // Reopened with the view already mounted, it focuses the input as well.
  await page.keyboard.press("Alt+F12");
  await expect(terminal).toBeHidden();
  await page.keyboard.press("Alt+F12");
  await expect(terminal.getByRole("textbox", { name: "Terminal input" })).toBeFocused();
});

test("a terminal view that loads late doesn't take focus moved elsewhere meanwhile", async ({ workbench: page }) => {
  let release!: () => void;
  const loaded = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/src\/features\/terminal\/runtime\.ts/, async (route) => {
    await loaded;
    await route.continue();
  });
  await page.keyboard.press("Alt+F12");
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  await expect(terminal).toBeVisible();
  const tree = page.getByRole("tree", { name: "Project" });
  await tree.getByRole("treeitem", { name: "README.md" }).click();
  release();
  await expect(terminal.getByRole("textbox", { name: "Terminal input" })).toBeAttached();
  await expect(tree).toBeFocused();
});

test("Split Right gives the Terminal a tab group with its own header; Unsplit merges it back", async ({
  workbench: page,
}) => {
  const terminal = page.getByRole("region", { name: "Terminal" });
  const strips = terminal.getByRole("tablist", { name: "Terminal sessions" });
  await page.keyboard.press("Alt+F12");
  await expect(strips.getByRole("tab", { name: "Local" })).toBeVisible();

  await strips.getByRole("tab", { name: "Local" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Split Right/ }).click();
  await expect(strips).toHaveCount(2);
  await expect(strips.nth(1).getByRole("tab", { name: "Local (2)" })).toHaveAttribute("aria-selected", "true");
  // One header per group: the title in the first, the window's buttons in the last.
  await expect(terminal.locator("header")).toHaveCount(2);
  await expect(terminal.locator("header").nth(0)).toContainText("Terminal");
  await expect(terminal.locator("header").nth(1).getByRole("button", { name: "Options", exact: true })).toHaveCount(1);
  await expect(terminal.locator("header").nth(0).getByRole("button", { name: "Options", exact: true })).toHaveCount(0);
  if (process.env.OPENIDEA_E2E_SHOTS) await terminal.screenshot({ path: process.env.OPENIDEA_E2E_SHOTS });

  await strips.nth(1).getByRole("tab", { name: "Local (2)" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unsplit" }).click();
  await expect(strips).toHaveCount(1);
  await expect(strips.getByRole("tab")).toHaveText(["Local", "Local (2)"]);
  await expect(terminal.locator("header")).toHaveCount(1);
});

test("closing the last tab of a terminal group focuses its neighbour", async ({ workbench: page }) => {
  const terminal = page.getByRole("region", { name: "Terminal" });
  const strips = terminal.getByRole("tablist", { name: "Terminal sessions" });
  await page.keyboard.press("Alt+F12");
  await strips.getByRole("tab", { name: "Local" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Split Right/ }).click();
  await expect(strips).toHaveCount(2);
  await strips.nth(1).getByRole("button", { name: "Close Tab", exact: true }).click();
  await expect(strips).toHaveCount(1);
  await expect(terminal.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.press("Meta+t");
  await expect(strips.getByRole("tab")).toHaveCount(2);
});

test("⌘⇧F12 hides all tool windows and restores them", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+6");
  await expect(page.getByRole("region", { name: "Problems" })).toBeVisible();
  await page.keyboard.press("Meta+Shift+F12");
  expect(await visibleToolWindows(page)).toEqual([]);
  await page.keyboard.press("Meta+Shift+F12");
  await expect(page.getByRole("region", { name: "Project" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Problems" })).toBeVisible();
});

test("the Terminal sends typed commands to the shell and shows its output", async ({ workbench: page }) => {
  // The shell is stubbed at the IPC layer: it echoes input and answers `echo`.
  await stubDesktop(page);
  await page.evaluate(() => {
    let output: unknown = null;
    let line = "";
    const out = (text: string) => window.__ipc.send(output, text);
    const h = window.__ipc.handlers;
    h.term_default_shell = () => "/bin/zsh";
    h.term_available_shells = () => ["/bin/zsh"];
    h.term_spawn = (args) => {
      output = args.onOutput;
      setTimeout(() => out("acme-api % "), 20);
      return { id: 5, title: "zsh", pid: 99 };
    };
    h.term_resize = () => null;
    h.term_is_busy = () => false;
    h.term_write = (args) => {
      for (const ch of String(args.data)) {
        if (ch === "\r") {
          const said = /^echo (.*)$/.exec(line);
          out(`\r\n${said ? `${said[1]}\r\n` : ""}acme-api % `);
          line = "";
        } else {
          line += ch;
          out(ch);
        }
      }
      return null;
    };
  });
  await page.keyboard.press("Alt+F12");
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  const rows = terminal.locator(".xterm-rows");
  await expect(rows).toContainText("acme-api %");
  await terminal.locator(".xterm-screen").click();
  await expect(terminal.getByRole("textbox", { name: "Terminal input" })).toBeFocused();
  await page.keyboard.type("echo hello from e2e");
  await page.keyboard.press("Enter");
  await expect(rows.locator("div", { hasText: /^hello from e2e\s*$/ })).toHaveCount(1);
  const written = (await ipcCalls(page, "term_write")).map((a) => a.data).join("");
  expect(written).toBe("echo hello from e2e\r");
});
