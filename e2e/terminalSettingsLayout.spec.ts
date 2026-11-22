import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("Terminal settings keep shell controls and font groups readable as the window narrows", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1120, height: 900 });
  await stubDesktop(page);
  const shellPath = "C:/Program Files/Shell/bin/bash.exe";
  await page.evaluate((path) => {
    window.__ipc.handlers.settings_get_global = () => ({});
    window.__ipc.handlers.term_default_shell = () => "/bin/zsh";
    window.__ipc.handlers.term_available_shells = () => ["/bin/zsh", path];
  }, shellPath);
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = dialog.getByRole("textbox", { name: "Search settings" });
  await search.fill("Shell path");
  await dialog.getByRole("treeitem", { name: "Terminal", exact: true }).click();
  await search.clear();

  const directory = dialog.getByRole("textbox", { name: /^Start directory:?$/ });
  const shell = dialog.getByRole("textbox", { name: /^Shell path:?$/ });
  const tab = dialog.getByRole("textbox", { name: /^Default Tab name:?$/ });
  const shells = dialog.getByRole("button", { name: "Installed Shells", exact: true });
  const browse = dialog.getByRole("button", { name: "Browse", exact: true });
  const font = dialog.getByRole("combobox", { name: "Terminal font", exact: true });
  const fallback = dialog.getByRole("combobox", { name: "Terminal fallback font", exact: true });
  const size = dialog.getByRole("textbox", { name: "Terminal font size", exact: true });
  const lineHeight = dialog.getByRole("textbox", { name: "Terminal line height", exact: true });
  const column = dialog.getByRole("textbox", { name: "Terminal column width", exact: true });
  const bell = dialog.getByRole("checkbox", { name: "Audible bell", exact: true });
  const shortcuts = dialog.getByRole("checkbox", { name: "Override IDE shortcuts", exact: true });
  await expect(shell).toHaveAttribute("placeholder", "/bin/zsh");

  for (const width of [1120, 580, 520]) {
    await page.setViewportSize({ width, height: 900 });
    await shell.scrollIntoViewIfNeeded();
    await expect(shells).toBeInViewport({ ratio: 1 });
    await expect(browse).toBeInViewport({ ratio: 1 });
    const [dir, command, name, menu, chooseFile, main, secondary, fontSize, line, col, left, right] = await Promise.all(
      [directory, shell, tab, shells, browse, font, fallback, size, lineHeight, column, bell, shortcuts].map(
        (control) => control.boundingBox(),
      ),
    );
    if (
      !dir ||
      !command ||
      !name ||
      !menu ||
      !chooseFile ||
      !main ||
      !secondary ||
      !fontSize ||
      !line ||
      !col ||
      !left ||
      !right
    )
      throw new Error("Missing Terminal settings bounds");
    expect(command.y + command.height / 2).toBeCloseTo(menu.y + menu.height / 2, 0);
    expect(menu.y).toBeCloseTo(chooseFile.y, 0);
    expect(command.width).toBeGreaterThan(100);
    expect(command.x).toBeCloseTo(name.x, 0);
    expect(chooseFile.x + chooseFile.width).toBeCloseTo(name.x + name.width, 0);
    expect(dir.x + dir.width).toBeCloseTo(name.x + name.width, 0);
    expect(main.y).toBeLessThan(command.y);
    if (width === 1120) {
      expect(main.y).toBeCloseTo(secondary.y, 0);
      expect(fontSize.y).toBeCloseTo(line.y, 0);
      expect(fontSize.y).toBeCloseTo(col.y, 0);
      expect(right.x).toBeGreaterThan(left.x);
    } else {
      expect(command.x).toBeCloseTo(dir.x, 0);
      expect(secondary.y).toBeGreaterThan(main.y);
      expect(right.x).toBeCloseTo(left.x, 0);
      expect(right.y).toBeGreaterThan(left.y);
    }
  }

  await shells.click();
  await page.getByRole("menuitemcheckbox", { name: shellPath, exact: true }).click();
  await expect(shell).toHaveValue(`"${shellPath}"`);
  await expect(font).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "Use editor font", exact: true }).uncheck();
  await font.fill("Cascadia Mono");
  await size.fill("15");
  await expect(font).toHaveValue("Cascadia Mono");
  await expect(size).toHaveValue("15");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await ipcCalls(page, "settings_set")).toEqual([]);
});
