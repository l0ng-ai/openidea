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

test("hidden trees retain the virtual viewport and reconcile pending width changes when shown", async ({ page }) => {
  await open(page);
  const tree = page.getByRole("tree", { name: "Width fixture", includeHidden: true });
  const before = await measureLong(page, tree);
  const row = await tree.getByRole("treeitem", { name: /^z_long/ }).elementHandle();
  const top = await tree.evaluate((node) => node.scrollTop);
  const spacer = tree.locator("[data-content-width]");
  const stored = await spacer.evaluate((node) => (node as HTMLElement).style.width);
  await page.getByRole("button", { name: "Toggle visibility" }).click();
  await expect(tree).toBeHidden();
  await tree.evaluate((node) => node.dispatchEvent(new Event("scroll")));
  // Give ResizeObserver deliveries a chance to run while there is no layout.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }),
  );
  expect(await row.evaluate((node) => node.isConnected)).toBe(true);
  expect(await spacer.evaluate((node) => (node as HTMLElement).style.width)).toBe(stored);
  await page.getByRole("button", { name: "Toggle visibility" }).click();
  await expect(tree).toBeVisible();
  await expect.poll(() => metrics(tree)).toEqual(before);
  expect(await tree.evaluate((node) => node.scrollTop)).toBe(top);
  await page.getByRole("button", { name: "Toggle visibility" }).click();
  await page.getByRole("button", { name: "Delete widest" }).click();
  await page.getByRole("button", { name: "Change indent" }).click();
  await page.getByRole("button", { name: "Toggle visibility" }).click();
  await expect.poll(async () => (await metrics(tree)).width).toBe(240);
});

test("a scroll just before hiding takes effect when the tree is shown again", async ({ page }) => {
  const tree = await open(page);
  await wheel(page, tree, 0, 10000);
  await expect(tree.getByRole("treeitem", { name: /^z_long/ })).toBeVisible();
  const visibility = page.getByRole("button", { name: "Toggle visibility" });
  await visibility.evaluate((button) => {
    document.querySelector<HTMLElement>('[role="tree"]')!.scrollTop = 0;
    (button as HTMLButtonElement).click();
  });
  await expect(tree).toBeHidden();
  await visibility.click();
  expect(await tree.evaluate((node) => node.scrollTop)).toBe(0);
  await expect(tree.getByRole("treeitem", { name: "src", exact: true })).toBeVisible();
});

test("large wheel and thumb jumps keep the viewport covered", async ({ page }) => {
  await page.goto("/e2e/treeWidth.html?large");
  const tree = page.getByRole("tree", { name: "Width fixture" });
  await expect(tree.getByRole("treeitem", { name: "src", exact: true })).toBeVisible();
  const box = (await tree.boundingBox())!;
  const eventState = await tree.evaluateHandle((element) => {
    const coverage = () => {
      const { top, left } = element.getBoundingClientRect();
      const bottom = top + element.clientHeight;
      let covered = true;
      for (let y = top + 1; y < bottom; y += 8) {
        const row = element.ownerDocument.elementFromPoint(left + 12, y)?.closest("[data-row]");
        if (!row || !element.contains(row)) covered = false;
      }
      return { offset: element.scrollTop, covered, mounted: element.querySelectorAll("[data-row]").length };
    };
    const state = { wheel: coverage(), drag: coverage() };
    // At the end of the input event, before the browser can paint the new offset.
    window.addEventListener("wheel", () => (state.wheel = coverage()));
    window.addEventListener("pointermove", (event) => {
      if (event.buttons === 1) state.drag = coverage();
    });
    return state;
  });
  const maximum = await tree.evaluate((element) => element.scrollHeight - element.clientHeight);
  expect(maximum).toBeGreaterThan(140_000);

  await page.mouse.move(box.x + 40, box.y + 100);
  for (const [delta, offset] of [
    [40_000, 40_000],
    [80_000, 120_000],
    [-90_000, 30_000],
    [-50_000, 0],
  ] as const) {
    await page.mouse.wheel(0, delta);
    await expect.poll(async () => eventState.evaluate((state) => state.wheel.offset)).toBe(offset);
    expect(await eventState.evaluate((state) => state.wheel.covered)).toBe(true);
  }

  const thumbX = box.x + box.width - 5;
  const thumbY = box.y + 12;
  const travel = await page.evaluate(
    ({ x, y }) => {
      const thumb = document.elementFromPoint(x, y) as HTMLElement;
      return thumb.parentElement!.clientHeight - thumb.offsetHeight;
    },
    { x: thumbX, y: thumbY },
  );
  expect(travel).toBeGreaterThan(0);
  await page.mouse.move(thumbX, thumbY);
  await page.mouse.down();
  try {
    for (const fraction of [0.65, 0.2, 0.95, 0.4, 1]) {
      const distance = Math.round(travel * fraction);
      await page.mouse.move(thumbX, thumbY + distance);
      const state = await eventState.evaluate((state) => state.drag);
      expect(state.covered).toBe(true);
      expect(state.mounted).toBeLessThanOrEqual(40);
      expect(Math.abs(state.offset - (distance / travel) * maximum)).toBeLessThanOrEqual(1);
    }
  } finally {
    await page.mouse.up();
  }
  await expect(tree.getByRole("treeitem", { name: /^z_long/ })).toBeVisible();

  // The pointer can remain over the tree's scrollbar for the next wheel gesture.
  await page.mouse.move(thumbX, box.y + box.height - 12);
  await page.mouse.wheel(0, -maximum);
  await expect.poll(async () => eventState.evaluate((state) => state.wheel.offset)).toBe(0);
  expect(await eventState.evaluate((state) => state.wheel.covered)).toBe(true);
  await expect(tree.getByRole("treeitem", { name: "src", exact: true })).toBeVisible();
});
