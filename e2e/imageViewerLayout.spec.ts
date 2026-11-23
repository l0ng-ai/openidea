import { expect, stubDesktop, test } from "./fixtures";

test("image controls and metadata stay readable in a narrow editor", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1080, height: 700 });
  await stubDesktop(page);
  await page.evaluate(async () => {
    const path = "/dev/acme-api/status.svg";
    const image =
      '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="96"><rect width="128" height="96"/></svg>';
    window.__ipc.handlers.fs_read_image = () => "data:image/svg+xml," + encodeURIComponent(image);
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
  const showText = toolbar.getByRole("button", { name: "Open as Text", exact: true });
  const dimensions = toolbar.getByText(/128\s*×\s*96/);
  await expect(page.getByRole("img", { name: "status.svg", exact: true })).toBeVisible();
  await expect(dimensions).toBeVisible();
  const wideHeight = (await toolbar.boundingBox())!.height;

  await page.getByRole("button", { name: "Split Right", exact: true }).click();
  await expect(toolbars).toHaveCount(2);
  await page.setViewportSize({ width: 640, height: 570 });
  expect(await dimensions.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  expect((await toolbar.boundingBox())!.height).toBeGreaterThan(wideHeight);
  expect((await dimensions.boundingBox())!.y).toBeGreaterThan((await zoomIn.boundingBox())!.y);
  await expect(dimensions).toHaveCSS("font-size", "13px");
  await expect(showText).toHaveCSS("white-space", "nowrap");
  for (const item of [zoomIn, actualSize, chessboard, showText, dimensions]) {
    await expect(item).toBeInViewport({ ratio: 1 });
  }
  await expect(toolbar.getByText("4.0 KB", { exact: true })).toBeVisible();

  await zoomIn.click();
  await expect(toolbar.getByText("125%", { exact: true })).toBeVisible();
  await actualSize.click();
  await expect(toolbar.getByText("100%", { exact: true })).toBeVisible();
  await chessboard.click();
  await expect(chessboard).toHaveAttribute("aria-pressed", "false");
  await showText.click();
  await expect(page.locator(".cm-content")).toBeVisible();
});
