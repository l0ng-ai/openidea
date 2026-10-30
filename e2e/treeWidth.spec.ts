import { expect, test, type Locator, type Page } from "@playwright/test";

const metrics = (tree: Locator) =>
  tree.evaluate((node) => ({ width: node.scrollWidth, left: node.scrollLeft, viewport: node.clientWidth }));
async function open(page: Page) {
  await page.goto("/e2e/treeWidth.html");
  const tree = page.getByRole("tree", { name: "Width fixture" });
  await expect(tree.getByRole("treeitem", { name: "src", exact: true })).toBeVisible();
  return tree;
}
async function wheel(page: Page, tree: Locator, x: number, y: number) {
  await tree.hover();
  await page.mouse.wheel(x, y);
  await expect
    .poll(async () => tree.evaluate((node) => node.scrollTop === node.scrollHeight - node.clientHeight))
    .toBe(y > 0);
  if (y < 0) await expect.poll(async () => tree.evaluate((node) => node.scrollTop)).toBe(0);
}
async function measureLong(page: Page, tree: Locator) {
  await tree.getByRole("treeitem", { name: "src", exact: true }).click();
  await wheel(page, tree, 0, 10000);
  await expect(tree.getByRole("treeitem", { name: /^z_long/ })).toBeVisible();
  await page.mouse.wheel(200, 0);
  await expect.poll(async () => (await metrics(tree)).left).toBe(200);
  return metrics(tree);
}

test("keeps offscreen width when an unrelated directory expands, without transient clamping", async ({ page }) => {
  const tree = await open(page);
  const before = await measureLong(page, tree);
  await wheel(page, tree, 0, -10000);
  await expect(tree.getByRole("treeitem", { name: /^z_long/ })).toHaveCount(0);
  expect(await metrics(tree)).toEqual(before);
  await tree.evaluate((node) => {
    const samples: number[] = [];
    Object.assign(window, { widthSamples: samples });
    let frames = 0;
    const sample = () => {
      samples.push(node.scrollLeft);
      if (++frames < 30) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.keyboard.press("ArrowRight");
  await expect(tree.getByRole("treeitem", { name: "src", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { widthSamples: number[] }).widthSamples.length))
    .toBe(30);
  const after = await metrics(tree);
  console.log("unrelated expansion", { before, after });
  expect(after).toEqual(before);
  expect(await page.evaluate(() => Math.min(...(window as unknown as { widthSamples: number[] }).widthSamples))).toBe(
    200,
  );
});

test("deleting, collapsing and filtering the widest row allow shrinkage", async ({ page }) => {
  let tree = await open(page);
  await measureLong(page, tree);
  await wheel(page, tree, 0, -10000);
  await page.getByRole("button", { name: "Delete widest" }).click();
  await expect.poll(async () => (await metrics(tree)).width).toBe(240);
  tree = await open(page);
  await measureLong(page, tree);
  await wheel(page, tree, 0, -10000);
  await page.getByRole("button", { name: "Nest rows" }).click();
  await tree.getByRole("treeitem", { name: "folder", exact: true }).click();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await metrics(tree)).width).toBe(240);
  tree = await open(page);
  await measureLong(page, tree);
  await page.keyboard.type("src");
  await expect.poll(async () => (await metrics(tree)).width).toBe(240);
});

test("same-key content, depth, font and indent are remeasured", async ({ page }) => {
  const tree = await open(page);
  const initial = await measureLong(page, tree);
  // An external style/font update need not cause a React render.
  const fontStyle = await page.addStyleTag({ content: '[role="tree"] { font-size: 20px; }' });
  await expect.poll(async () => (await metrics(tree)).width).toBeGreaterThan(initial.width);
  await fontStyle.evaluate((node) => node.parentNode!.removeChild(node));
  await expect.poll(async () => (await metrics(tree)).width).toBe(initial.width);
  await page.getByRole("button", { name: "Change font" }).click();
  await expect.poll(async () => (await metrics(tree)).width).toBeGreaterThan(initial.width);
  await page.getByRole("button", { name: "Change font" }).click();
  await expect.poll(async () => (await metrics(tree)).width).toBe(initial.width);
  await page.getByRole("button", { name: "Nest rows" }).click();
  await tree.focus();
  await page.keyboard.press("End");
  await expect.poll(async () => (await metrics(tree)).width).toBe(initial.width + 16);
  await page.getByRole("button", { name: "Change indent" }).click();
  await expect.poll(async () => (await metrics(tree)).width).toBe(initial.width + 40);
  await page.getByRole("button", { name: "Shorten same key" }).click();
  await expect.poll(async () => (await metrics(tree)).width).toBe(240);
});

test("panel resizing does not cache the viewport floor, and horizontal mode can be disabled", async ({ page }) => {
  const tree = await open(page);
  await page.getByRole("button", { name: "Resize panel" }).click();
  await expect.poll(async () => (await metrics(tree)).viewport).toBe(2400);
  await wheel(page, tree, 0, 10000);
  await wheel(page, tree, 0, -10000);
  await page.getByRole("button", { name: "Resize panel" }).click();
  await expect.poll(async () => (await metrics(tree)).viewport).toBe(240);
  expect((await metrics(tree)).width).toBeLessThan(2400);
  expect((await metrics(tree)).width).toBeGreaterThan(240);
  await page.getByRole("button", { name: "Toggle horizontal" }).click();
  await expect(tree.locator("[data-content-width]")).toHaveCount(0);
  await expect.poll(async () => (await metrics(tree)).width).toBe(240);
  await wheel(page, tree, 0, 10000);
  await expect.poll(async () => (await metrics(tree)).width).toBe(240);
  await page.getByRole("button", { name: "Shorten same key" }).click();
  await page.getByRole("button", { name: "Toggle horizontal" }).click();
  await expect(tree.locator("[data-content-width]")).toHaveCount(1);
  await expect.poll(async () => (await metrics(tree)).width).toBe(240);
});

test("offscreen same-key updates remain estimates until the row is mounted again", async ({ page }) => {
  const tree = await open(page);
  const before = await measureLong(page, tree);
  await wheel(page, tree, 0, -10000);
  await page.getByRole("button", { name: "Shorten same key" }).click();
  expect(await metrics(tree)).toEqual(before);
  await wheel(page, tree, 0, 10000);
  await expect(tree.getByRole("treeitem", { name: "short.ts", exact: true })).toBeVisible();
  await expect.poll(async () => (await metrics(tree)).width).toBe(240);
  await wheel(page, tree, 0, -10000);
  await page.getByRole("button", { name: "Resize panel" }).click();
  await wheel(page, tree, 0, 10000);
  await page.getByRole("button", { name: "Resize panel" }).click();
  await expect.poll(async () => (await metrics(tree)).width).toBe(240);
});

test("hidden trees keep their widths and reconcile pending removals when shown", async ({ page }) => {
  await open(page);
  const tree = page.getByRole("tree", { name: "Width fixture", includeHidden: true });
  const before = await measureLong(page, tree);
  const spacer = tree.locator("[data-content-width]");
  const stored = await spacer.evaluate((node) => (node as HTMLElement).style.width);
  await page.getByRole("button", { name: "Toggle visibility" }).click();
  await expect(tree).toBeHidden();
  // Give ResizeObserver deliveries a chance to run while there is no layout.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }),
  );
  expect(await spacer.evaluate((node) => (node as HTMLElement).style.width)).toBe(stored);
  await page.getByRole("button", { name: "Toggle visibility" }).click();
  await expect(tree).toBeVisible();
  await expect.poll(() => metrics(tree)).toEqual(before);
  await page.getByRole("button", { name: "Toggle visibility" }).click();
  await page.getByRole("button", { name: "Delete widest" }).click();
  await page.getByRole("button", { name: "Change indent" }).click();
  await page.getByRole("button", { name: "Toggle visibility" }).click();
  await expect.poll(async () => (await metrics(tree)).width).toBe(240);
});
