import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

test("editor notification actions stay inside narrow splits", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1160, height: 720 });
  const editor = await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.evaluate(async () => {
    const path = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ path);
    const settings = useProject.getState().settings;
    window.__ipc.handlers.settings_set = ({ value }) => ({
      ...settings,
      general: { powerSaveMode: value === "true" },
    });
    useProject.setState({ settings: { ...settings, general: { powerSaveMode: true } } });
  });
  const banners = page.getByRole("status").filter({ hasText: /^Power save mode is on/ });
  const message = banners.first().getByText(/^Power save mode is on/);
  const turnOff = banners.first().getByRole("button", { name: "Turn Off" });
  await expect(turnOff).toBeVisible();
  await expect(message).toHaveCSS("font-size", "13px");
  const wide = (await message.boundingBox())!;
  expect((await turnOff.boundingBox())!.y).toBeLessThan(wide.y + wide.height);

  await editor.locator(".cm-content").focus();
  await page.evaluate(async () => {
    const path = "/src/platform/actions.ts";
    await (await import(/* @vite-ignore */ path)).executeAction("editor.splitRight");
  });
  await expect(banners).toHaveCount(2);
  await page.setViewportSize({ width: 600, height: 720 });
  await expect
    .poll(
      () =>
        banners.evaluateAll((panels) =>
          panels.every((panel) => {
            const box = panel.getBoundingClientRect();
            const action = panel.querySelector("button")!.getBoundingClientRect();
            return action.left >= box.left && action.right <= box.right && panel.scrollWidth <= panel.clientWidth + 1;
          }),
        ),
      { message: "Turn Off fits inside each split editor notification" },
    )
    .toBe(true);
  const narrow = (await message.boundingBox())!;
  expect(narrow.height).toBeGreaterThan(wide.height * 1.5);
  expect((await turnOff.boundingBox())!.y).toBeGreaterThanOrEqual(narrow.y + narrow.height);

  await expect(banners.first()).toHaveCSS("padding-top", "10px");
  await page.locator("html").evaluate((root) => root.setAttribute("data-compact", ""));
  await expect(banners.first()).toHaveCSS("padding-top", "6px");
  await turnOff.press("Enter");
  await expect(banners).toHaveCount(0);
  expect(await ipcCalls(page, "settings_set")).toContainEqual({
    scope: "global",
    key: "general.powerSaveMode",
    value: "false",
  });
});
