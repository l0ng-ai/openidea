import { expect, stubDesktop, test } from "./fixtures";

test("image controls and metadata stay readable in a narrow editor", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1080, height: 700 });
  await stubDesktop(page);
  await page.evaluate(async () => {
    const path = "/dev/acme-api/status.png";
    // A black 128 × 96 PNG.
    const image =
      "iVBORw0KGgoAAAANSUhEUgAAAIAAAABgCAYAAADVenpJAAAAtklEQVR42u3SQREAAAyDMPyb3oQ0jxjgqDqmiWAADIABMAAGwAAYAANgAAyAATAABsAAGAADYAAMgAEwAAbAABgAA2AADIABMAAGwAAYAANgAAyAATAABsAAGAADYAAMgAEwAAbAABgAA2AADIABMAAGwAAYAANgAAyAATAABsAAGAADYAAMgAEwAAbAABgAA2AADIABMAAGwAAYAANgAAyAATAABkAEA2AADIABMAAGwAAYgAUPjHPSwnYk55QAAAAASUVORK5CYII=";
    window.__ipc.handlers.fs_read_image = () => "data:image/png;base64," + image;
    window.__ipc.handlers.fs_probe = () => ({ size: 4096, binary: false, tooLarge: false });
    const contributions = "/src/workbench/contributions.ts";
    const { editorService } = await import(/* @vite-ignore */ contributions);
    await editorService().openFile(path);
  });
  const toolbars = page.getByRole("toolbar", { name: "Image viewer", exact: true });
  const toolbar = toolbars.last();
  const zoomIn = toolbar.getByRole("button", { name: "Zoom In", exact: true });
  const actualSize = toolbar.getByRole("button", { name: "Actual Size", exact: true });
  const chessboard = toolbar.getByRole("button", { name: "Show Chessboard", exact: true });
  const dimensions = toolbar.getByText(/128\s*×\s*96/);
  await expect(page.getByRole("img", { name: "status.png", exact: true })).toBeVisible();
  await expect(dimensions).toBeVisible();
  const wideHeight = (await toolbar.boundingBox())!.height;

  await page.getByRole("button", { name: "Split Right", exact: true }).click();
  await expect(toolbars).toHaveCount(2);
  await page.setViewportSize({ width: 640, height: 570 });
  expect(await dimensions.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  expect((await toolbar.boundingBox())!.height).toBeGreaterThan(wideHeight);
  expect((await dimensions.boundingBox())!.y).toBeGreaterThan((await zoomIn.boundingBox())!.y);
  await expect(dimensions).toHaveCSS("font-size", "13px");
  for (const item of [zoomIn, actualSize, chessboard, dimensions]) {
    await expect(item).toBeInViewport({ ratio: 1 });
  }
  await expect(toolbar.getByText("4.0 KB", { exact: true })).toBeVisible();

  await zoomIn.click();
  await expect(toolbar.getByText("125%", { exact: true })).toBeVisible();
  await actualSize.click();
  await expect(toolbar.getByText("100%", { exact: true })).toBeVisible();
  await chessboard.click();
  await expect(chessboard).toHaveAttribute("aria-pressed", "false");
});

test("an SVG file opens as its source with the image beside it", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    window.__ipc.handlers.fs_probe = () => ({ size: 96, binary: false, tooLarge: false });
    const contributions = "/src/workbench/contributions.ts";
    const { editorService } = await import(/* @vite-ignore */ contributions);
    await editorService().openFile("/dev/acme-api/status.svg");
  });
  const toolbar = page.getByRole("toolbar", { name: "Image viewer", exact: true });
  // Not an SVG yet: the preview says so, and draws the source once it is typed.
  await expect(page.getByText("The SVG source is not valid.", { exact: true })).toBeVisible();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.insertText(
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="96"><rect width="128" height="96"/></svg>',
  );
  await expect(page.getByRole("img", { name: "status.svg", exact: true })).toBeVisible();
  await expect(toolbar.getByText(/128\s*×\s*96/)).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Open as Text", exact: true })).toHaveCount(0);

  const layout = page.getByRole("toolbar", { name: "SVG editor layout", exact: true });
  await layout.getByRole("button", { name: "Preview Only", exact: true }).click();
  await expect(page.locator(".cm-content")).toBeHidden();
  await expect(page.getByRole("img", { name: "status.svg", exact: true })).toBeVisible();
  await layout.getByRole("button", { name: "Editor Only", exact: true }).click();
  await expect(toolbar).toHaveCount(0);
  await expect(page.locator(".cm-content")).toBeVisible();
});
