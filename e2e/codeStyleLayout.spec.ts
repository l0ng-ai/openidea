import { expect, stubDesktop, test } from "./fixtures";

test("Code Style keeps settings reachable by tab, keyboard, and search in a narrow pane", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 620, height: 720 });
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await stubDesktop(page);
  await page.evaluate(async () => {
    window.__ipc.handlers.languages = () => [
      { id: "typescript", name: "TypeScript", indent: { tabSize: 2, insertSpaces: true }, lineComment: "//" },
    ];
    const languageList = "/src/platform/languageList.ts";
    (await import(/* @vite-ignore */ languageList)).languageListChanged();
  });

  const search = dialog.getByRole("textbox", { name: "Search settings" });
  await search.fill("typescript");
  await dialog.getByRole("treeitem", { name: "TypeScript", exact: true, level: 3 }).click();
  await search.clear();

  const tabs = dialog.getByRole("tablist", { name: "Code Style" });
  const indents = tabs.getByRole("tab", { name: "Tabs and Indents" });
  const wrapping = tabs.getByRole("tab", { name: "Wrapping", exact: true });
  const comments = tabs.getByRole("tab", { name: "Comment Code" });
  await expect(indents).toHaveAttribute("aria-selected", "true");
  const size = dialog.getByRole("textbox", { name: "Tab size", exact: true });
  const indent = dialog.getByRole("textbox", { name: "Indent", exact: true });
  await expect(indent).toBeVisible();
  expect((await indent.boundingBox())!.x).toBeCloseTo((await size.boundingBox())!.x, 0);
  await size.fill("6");
  await indents.press("ArrowRight");
  await expect(wrapping).toBeFocused();
  await expect(dialog.getByRole("textbox", { name: "Hard wrap at", exact: true })).toBeVisible();
  await expect(size).toBeHidden();

  await search.fill("TypeScript line comment at first column");
  await expect(comments).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("checkbox", { name: "Line comment at first column" })).toBeVisible();
  await indents.click();
  await expect(size).toHaveValue("6");
  await page.setViewportSize({ width: 520, height: 720 });
  const body = dialog.locator("[class*='pageBody']");
  await expect.poll(() => body.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(dialog.getByRole("button", { name: "Copy to Project", exact: true })).toBeVisible();

  await search.fill("do not format");
  await dialog.getByRole("treeitem", { name: "Code Style", exact: true, level: 2 }).click();
  await expect(dialog.getByRole("tab", { name: "Formatter", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("listbox", { name: "Do not format" })).toBeVisible();
});
