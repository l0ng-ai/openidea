import { expect, openFromTree, test } from "./fixtures";

test("keeps diagnostic text and file counts visible in a narrow Problems pane", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 720, height: 760 });
  await page.evaluate(async () => {
    const projectModule = "/src/platform/project.ts";
    const problemsModule = "/src/features/code-insight/problemsStore.ts";
    const { useProject } = await import(/* @vite-ignore */ projectModule);
    const { applyDiagnosticsEvent } = await import(/* @vite-ignore */ problemsModule);
    const root = useProject.getState().project.root;
    const path = `${root}/src/features/checkout/shared/services/with-a-long-directory-name/for-order-processing/orders.ts`;
    const source = "typescript-eslint-application-rules-with-a-very-long-source-label";
    applyDiagnosticsEvent(path, source, [
      {
        range: { start: { line: 2, col: 2 }, end: { line: 2, col: 9 } },
        severity: "error",
        source,
        message: "Invalid order total",
      },
    ]);
  });

  await page.getByRole("button", { name: "Problems", exact: true }).click();
  const pane = page.locator('[data-toolwindow="problems"]');
  await pane.getByRole("tab", { name: /Project Errors/ }).click();
  await expect(pane.getByRole("toolbar", { name: "Problems actions" })).toHaveAttribute("aria-orientation", "vertical");
  const tree = pane.getByRole("tree", { name: "Problems" });
  const count = tree.getByText("1 error", { exact: true });
  const message = tree.getByText("Invalid order total", { exact: true });
  await expect(count).toBeVisible();
  await expect(message).toBeVisible();
  await expect.poll(() => message.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect.poll(() => tree.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("Problems stacks the preview in a side dock and remembers both divider positions", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openFromTree(page, "build.gradle.kts");
  await page.evaluate(async () => {
    const projectModule = "/src/platform/project.ts";
    const problemsModule = "/src/features/code-insight/problemsStore.ts";
    const { useProject } = await import(/* @vite-ignore */ projectModule);
    const { applyDiagnosticsEvent } = await import(/* @vite-ignore */ problemsModule);
    const path = `${useProject.getState().project.root}/build.gradle.kts`;
    applyDiagnosticsEvent(path, "kotlin", [
      {
        range: { start: { line: 1, col: 2 }, end: { line: 1, col: 8 } },
        severity: "error",
        source: "kotlin",
        message: "Invalid plugin configuration",
      },
    ]);
  });
  const move = (anchor: "right" | "bottom") =>
    page.evaluate(async (anchor) => {
      const path = "/src/workbench/toolwindows/store.ts";
      const { moveToolWindow, setToolWindowSize, showToolWindow } = await import(/* @vite-ignore */ path);
      moveToolWindow("problems", anchor);
      setToolWindowSize(anchor, 280);
      showToolWindow("problems", true);
    }, anchor);
  await move("right");

  const pane = page.getByRole("region", { name: "Problems", exact: true });
  const toolbar = pane.getByRole("toolbar", { name: "Problems actions" });
  const tree = pane.getByRole("tree", { name: "Problems" });
  const diagnostic = tree.getByRole("treeitem", { name: /Invalid plugin configuration/ });
  await pane.getByRole("button", { name: "Options", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Show Preview", exact: true }).click();
  await diagnostic.click();
  const preview = pane.getByRole("region", { name: "Preview", exact: true });
  await expect(toolbar).toHaveAttribute("aria-orientation", "horizontal");
  await expect(preview).toContainText("class OrderController");

  const box = (await tree.boundingBox())!;
  const code = (await preview.boundingBox())!;
  expect(code.y).toBeGreaterThanOrEqual(box.y + box.height - 1);
  expect(Math.abs(code.width - box.width)).toBeLessThan(2);
  expect((await toolbar.boundingBox())!.y).toBeLessThan(box.y);

  const handle = pane.getByRole("separator");
  const size = async () => Number(await handle.getAttribute("aria-valuenow"));
  const resize = async (key: string) => {
    const previous = await size();
    await handle.press(key);
    await expect.poll(size).not.toBe(previous);
    return size();
  };
  const sideSize = await resize("ArrowDown");
  await move("bottom");
  await expect(toolbar).toHaveAttribute("aria-orientation", "vertical");
  await expect.poll(size).toBeCloseTo(50, 0);
  await diagnostic.click();
  await expect(preview).toContainText("class OrderController");
  const bottomTree = (await tree.boundingBox())!;
  const bottomCode = (await preview.boundingBox())!;
  expect(bottomCode.x).toBeGreaterThanOrEqual(bottomTree.x + bottomTree.width - 1);
  const bottomSize = await resize("ArrowLeft");

  await move("right");
  await expect.poll(size).toBeCloseTo(sideSize, 0);
  await move("bottom");
  await expect.poll(size).toBeCloseTo(bottomSize, 0);
});
