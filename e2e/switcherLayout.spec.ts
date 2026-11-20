import { expect, openFromTree, test } from "./fixtures";

test("Switcher keeps the open file list and path visible in a narrow workbench", async ({ workbench: page }) => {
  await openFromTree(page, "README.md");
  await openFromTree(page, "App.tsx");
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");

  const switcher = page.getByRole("dialog", { name: "Switcher", exact: true });
  const files = switcher.getByRole("listbox", { name: "Open files" });
  const tools = switcher.getByRole("listbox", { name: "Tool windows" });
  const selected = files.getByRole("option", { selected: true });
  await expect(selected).toHaveText("README.md");
  expect((await switcher.boundingBox())!.width).toBeLessThan(600);

  await page.setViewportSize({ width: 400, height: 500 });
  await expect.poll(async () => (await files.boundingBox())!.width).toBeGreaterThan(225);
  const footer = switcher.locator("footer");
  await expect(footer).toHaveText(/README\.md$/);
  await expect(footer).toBeInViewport({ ratio: 1 });
  await expect(footer).toHaveCSS("font-size", "12px");
  expect(await tools.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  expect(await files.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  const structure = tools.getByText("Structure", { exact: true });
  expect(await structure.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);

  await page.keyboard.press("Tab");
  const activeTool = tools.getByRole("option", { selected: true });
  await expect(activeTool).toBeInViewport({ ratio: 1 });
  const firstTool = await activeTool.getAttribute("aria-posinset");
  await page.keyboard.press("PageDown");
  await page.keyboard.press("PageDown");
  await expect(activeTool).not.toHaveAttribute("aria-posinset", firstTool!);
  await expect(activeTool).toBeInViewport({ ratio: 0.98 });
  expect(await tools.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press("Shift+Tab");
  await expect(selected).toHaveText("README.md");
  await page.keyboard.up("Control");

  await expect(switcher).toBeHidden();
  await expect(page.getByRole("tab", { name: "README.md", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("Switcher takes up less space when both lists have only a few entries", async ({ workbench: page }) => {
  await openFromTree(page, "README.md");
  await openFromTree(page, "App.tsx");
  await page.evaluate(async () => {
    const path = "/src/workbench/contributions.ts";
    const { useContributions } = (await import(
      /* @vite-ignore */ path
    )) as typeof import("../src/workbench/contributions");
    useContributions.setState(({ toolWindows }) => ({
      toolWindows: new Map([...toolWindows].filter(([id]) => id === "project" || id === "terminal")),
    }));
  });
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  const switcher = page.getByRole("dialog", { name: "Switcher", exact: true });
  const tools = switcher.getByRole("listbox", { name: "Tool windows" });
  await expect(tools.getByRole("option")).toHaveCount(2);
  await expect.poll(async () => (await switcher.boundingBox())!.height).toBeLessThan(380);
  await expect(switcher.locator("footer")).toHaveText(/README\.md$/);
  await page.keyboard.press("Escape");
  await page.keyboard.up("Control");
});
