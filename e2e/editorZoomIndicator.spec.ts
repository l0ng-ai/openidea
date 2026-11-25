import { expect, openFromTree, stubDesktop, test } from "./fixtures";

test("editor zoom shows a local size indicator with reset and settings", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  await editor.locator(".cm-content").focus();
  await page.evaluate(async () => {
    const path = "/src/platform/actions.ts";
    await (await import(/* @vite-ignore */ path)).executeAction("editor.splitRight");
  });
  const panes = page.locator("[data-pane-id]");
  await expect(panes).toHaveCount(2);
  const left = panes.first().locator(".cm-content");
  const right = panes.last().locator(".cm-content");
  const original = await right.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  await page.setViewportSize({ width: 620, height: 680 });

  const indicator = panes.last().getByRole("group", { name: "Editor font size" });
  const zoom = () => right.press("Alt+Shift+.");
  await zoom();
  await expect(right).toHaveCSS("font-size", `${original + 1}px`);
  await expect(indicator.getByRole("status")).toHaveText(`Font size: ${original + 1} px`);
  await expect(indicator).toBeInViewport({ ratio: 1 });
  await expect(left).toHaveCSS("font-size", `${original}px`);
  await expect(panes.first().getByRole("group", { name: "Editor font size" })).toHaveCount(0);
  const paneBounds = (await panes.last().boundingBox())!;
  const bounds = (await indicator.boundingBox())!;
  expect(bounds.x).toBeGreaterThan(paneBounds.x);
  expect(bounds.x + bounds.width).toBeLessThan(paneBounds.x + paneBounds.width);

  await zoom();
  await expect(indicator.getByRole("status")).toHaveText(`Font size: ${original + 2} px`);
  await indicator.getByRole("button", { name: "Reset Font Size" }).press("Enter");
  await expect(right).toBeFocused();
  await expect(right).toHaveCSS("font-size", `${original}px`);
  await expect(indicator).toBeHidden();

  await page.evaluate(async () => {
    const path = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ path);
    const settings = useProject.getState().settings;
    useProject.setState({
      settings: { ...settings, editor: { ...settings?.editor, general: { wheelZoom: true, wheelZoomScope: "all" } } },
    });
  });
  await left.dispatchEvent("wheel", { metaKey: true, deltaY: -100, bubbles: true, cancelable: true });
  const leftIndicator = panes.first().getByRole("group", { name: "Editor font size" });
  await expect(leftIndicator.getByRole("status")).toHaveText(`Font size: ${original + 1} px`);
  await expect(right).toHaveCSS("font-size", `${original + 1}px`);
  await expect(indicator).toBeHidden();
  await leftIndicator.getByRole("button", { name: "Reset Font Size" }).click();
  await expect(left).toHaveCSS("font-size", `${original}px`);
  await expect(right).toHaveCSS("font-size", `${original}px`);

  await page.clock.install();
  await zoom();
  await expect(indicator).toBeVisible();
  await indicator.getByRole("button", { name: "Reset Font Size" }).focus();
  await page.clock.fastForward(5200);
  await expect(indicator).toBeVisible();
  await right.focus();
  await page.clock.fastForward(5200);
  await expect(indicator).toBeHidden();

  await zoom();
  await indicator.getByRole("button", { name: "Open Editor Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByText("Mouse Control", { exact: true })).toBeVisible();
  await expect(indicator).toBeHidden();
});

test("LightEdit resets wheel zoom from its font size indicator", async ({ workbench: page }) => {
  await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.evaluate(async () => {
    const projectPath = "/src/platform/project.ts";
    const editorPath = "/src/editor/core/controller.ts";
    const { openLightEdit } = await import(/* @vite-ignore */ projectPath);
    const { editorController } = await import(/* @vite-ignore */ editorPath);
    const editor = editorController();
    const file = editor.activePath()!;
    window.__ipc.handlers.light_edit_open = () => ({ editor: { general: { wheelZoom: true } } });
    await openLightEdit(file);
    await editor.openFile(file);
  });
  const lightEdit = page.locator("[data-light-edit]");
  const content = lightEdit.locator(".cm-content");
  await expect(content).toBeVisible();
  const original = await content.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  await content.dispatchEvent("wheel", { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true });
  const indicator = lightEdit.getByRole("group", { name: "Editor font size" });
  await expect(indicator.getByRole("status")).toHaveText(`Font size: ${original + 1} px`);
  await indicator.getByRole("button", { name: "Reset Font Size" }).click();
  await expect(content).toHaveCSS("font-size", `${original}px`);
  await expect(indicator).toBeHidden();
});
