import type { Locator, Page } from "@playwright/test";
import { expect, stubDesktop, test } from "./fixtures";

const longName = "Production logs — inventory reconciliation and overnight deployment checks";

async function openTerminal(page: Page, width: number) {
  await stubDesktop(page);
  await page.evaluate(async (width) => {
    const handlers = window.__ipc.handlers;
    let id = 0;
    handlers.term_default_shell = () => "/bin/zsh";
    handlers.term_available_shells = () => ["/bin/zsh"];
    handlers.term_spawn = () => ({ id: ++id, title: "zsh", pid: id });
    handlers.term_resize = () => null;
    handlers.term_kill = () => null;
    const path = "/src/workbench/toolwindows/store.ts";
    const layout = await import(path);
    layout.moveToolWindow("terminal", "right");
    layout.setToolWindowSize("right", width);
    layout.showToolWindow("terminal", true);
  }, width);
  return page.getByRole("region", { name: "Terminal", exact: true });
}

async function renameTerminal(tab: Locator, name: string) {
  await tab.dblclick();
  const input = tab.page().getByRole("textbox", { name: "Tab name" });
  await input.fill(name);
  await input.press("Enter");
}

async function expectSelectedTabToFit(strip: Locator) {
  const selected = strip.getByRole("tab", { selected: true });
  await expect(selected).toBeVisible();
  await expect
    .poll(() =>
      selected.evaluate((tab) => {
        const clip = tab.closest('[role="tablist"]')!.getBoundingClientRect();
        const slot = tab.parentElement!.getBoundingClientRect();
        return slot.left >= clip.left - 1 && slot.right <= clip.right + 1;
      }),
    )
    .toBe(true);
}

test("a narrow terminal panel keeps the selected tab's close button in view", async ({ workbench: page }) => {
  const terminal = await openTerminal(page, 220);
  const strip = terminal.getByRole("tablist", { name: "Terminal sessions" });
  await renameTerminal(strip.getByRole("tab", { name: "Local", exact: true }), longName);
  const selected = strip.getByRole("tab", { name: longName, selected: true });
  await expect(selected).toBeVisible();
  await expectSelectedTabToFit(strip);
  await expect
    .poll(() =>
      selected.getByText(longName, { exact: true }).evaluate((label) => label.scrollWidth > label.clientWidth),
    )
    .toBe(true);
  await expect(selected).toHaveAttribute("data-tooltip", new RegExp(longName));
  await expect(terminal.getByRole("button", { name: "Show Hidden Tabs" })).toBeHidden();
  await expect(terminal.getByRole("button", { name: "New Tab", exact: true })).toBeVisible();
  await terminal.getByRole("button", { name: "New Predefined Session" }).click();
  await expect(page.getByRole("menuitem", { name: "zsh", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await strip.getByRole("button", { name: "Close Tab", exact: true }).click();
  await expect(terminal).toBeHidden();
});

test("terminal split tabs fit when sessions overflow and switch through the menu", async ({ workbench: page }) => {
  const terminal = await openTerminal(page, 520);
  const strips = terminal.getByRole("tablist", { name: "Terminal sessions" });
  await strips.getByRole("tab", { name: "Local", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Split Right/ }).click();
  await expect(strips).toHaveCount(2);
  const header = terminal.locator("header").nth(1);
  const strip = strips.nth(1);
  await header.getByRole("button", { name: "New Tab", exact: true }).click();
  await renameTerminal(strip.getByRole("tab", { selected: true }), longName);
  await expect(strip.getByRole("tab", { name: longName, selected: true })).toBeVisible();
  await expectSelectedTabToFit(strip);
  const hidden = header.getByRole("button", { name: "Show Hidden Tabs" });
  await hidden.click();
  await page.getByRole("menuitem", { name: "Local (2)", exact: true }).click();
  await expect(strip.getByRole("tab", { name: "Local (2)", selected: true })).toBeVisible();
  await expectSelectedTabToFit(strip);
  await expect(header.getByRole("button", { name: "New Predefined Session" })).toBeVisible();
  await hidden.click();
  await page.getByRole("menuitem", { name: longName, exact: true }).click();
  await expect(strip.getByRole("tab", { name: longName, selected: true })).toBeVisible();
  await expectSelectedTabToFit(strip);
});

test("the terminal session chooser lists shells first and window options own the split commands", async ({
  workbench: page,
}) => {
  const terminal = await openTerminal(page, 520);
  const chooser = terminal.getByRole("button", { name: "New Predefined Session", exact: true });
  await expect(chooser).toBeVisible();
  await chooser.press("Space");
  const sessions = page.getByRole("menu", { name: "New Predefined Session", exact: true });
  await expect(sessions.getByRole("menuitem")).toHaveText(["zsh", "SSH Session…", /^Settings/]);
  await page.keyboard.press("Home");
  await expect(sessions.getByRole("menuitem", { name: "zsh", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(sessions).toBeHidden();
  await expect(terminal.getByRole("tab", { name: "zsh", selected: true })).toBeVisible();

  await terminal.getByRole("button", { name: "Options", exact: true }).click();
  const options = page.getByRole("menu", { name: "Terminal options", exact: true });
  await expect(options.getByRole("menuitem", { name: /^Split Down/ })).toBeVisible();
  await expect(options.getByRole("menuitem", { name: /^Settings/ })).toBeVisible();
  await options.getByRole("menuitem", { name: /^Split Right/ }).click();
  await expect(terminal.getByRole("tablist", { name: "Terminal sessions" })).toHaveCount(2);
});
