import { expect, test } from "./fixtures";

test("line numbers stay smaller than the code and leave room for a breakpoint", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const backendPath = "/src/editor/core/backend.ts";
    const servicesPath = "/src/workbench/contributions.ts";
    const { docBackend } = await import(/* @vite-ignore */ backendPath);
    const { editorService } = await import(/* @vite-ignore */ servicesPath);
    const path = "/dev/acme-api/queue.ts";
    docBackend().files.set(path, ["const queue = [1, 2, 3];", "queue.push(4);", "console.log(queue);"].join("\n"));
    await editorService().openFile(path);
  });
  const editor = page.locator('.cm-editor[data-language="TypeScript"]');
  const content = editor.locator(".cm-content");
  const number = editor.locator(".cm-lineNumbers").getByText("2", { exact: true });
  await expect(number).toBeVisible();
  const size = await content.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  await expect(number).toHaveCSS("font-size", `${size - 1}px`);
  await expect(number).toHaveCSS("padding-inline-start", "4px");
  await expect(number).toHaveCSS("padding-inline-end", "4px");
  const column = editor.locator(".cm-lineNumbers");
  expect((await column.boundingBox())!.width).toBeCloseTo(24, 0);

  await number.click();
  const markerSize = () => number.evaluate((element) => getComputedStyle(element, "::before").width);
  await expect.poll(markerSize).toBe(`${size}px`);
  await expect
    .poll(() =>
      number.evaluate((element) => {
        const marker = getComputedStyle(element, "::before");
        return element.clientWidth - Number.parseFloat(marker.left) - Number.parseFloat(marker.width) / 2;
      }),
    )
    .toBeCloseTo(4, 0);

  await content.press("Alt+Shift+.");
  await expect(content).toHaveCSS("font-size", `${size + 1}px`);
  await expect(number).toHaveCSS("font-size", `${size}px`);
  await expect(number).toHaveCSS(
    "line-height",
    await content.evaluate((element) => getComputedStyle(element).lineHeight),
  );
  await expect.poll(markerSize).toBe(`${size + 1}px`);
});
