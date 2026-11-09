import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

for (const height of [990, 700, 560]) {
  test(`run configurations dialog keeps its toolbar and scrolls only inside the panes at ${height}px`, async ({
    workbench: page,
  }) => {
    await page.setViewportSize({ width: 900, height });
    await page.evaluate(async () => {
      const path = "/src/features/run/store.ts";
      const { useRun } = await import(/* @vite-ignore */ path);
      const configs = Array.from({ length: 60 }, (_, i) => ({
        id: `cfg-${i}`,
        name: `config ${i}`,
        kind: "application",
        command: "java",
        args: ["-cp", "runtime", "com.example.Main"],
        params: { mainClass: "com.example.Main", classpath: "runtime" },
        allowParallel: true,
        stdinFile: "input.txt",
        envFiles: [".env"],
        outputFile: "output.log",
        showOnStdout: true,
        showOnStderr: true,
        beforeLaunch: [{ kind: "build" }],
        buildPolicy: "noBuild",
        openToolWindow: true,
        focusToolWindow: true,
        cwd: null,
        env: {},
        detected: false,
        isTest: true,
        debugAdapter: "java-debug",
      }));
      useRun.setState({ configs, loaded: true, editorOpen: true, editTarget: "cfg-30" });
    });
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await checkScrolling(page, dialog);
    const initial = await dialog.boundingBox();
    expect(initial).not.toBeNull();
    await resize(page, dialog, -180);
    expect((await dialog.boundingBox())!.height).toBeLessThan(initial!.height - 100);
    await checkScrolling(page, dialog);
    await resize(page, dialog, 120);
    expect((await dialog.boundingBox())!.height).toBeGreaterThan(initial!.height - 100);
    await checkScrolling(page, dialog);
  });
}

async function resize(page: Page, dialog: Locator, dy: number) {
  const grip = await dialog.getByRole("separator", { name: "Resize", exact: true }).boundingBox();
  expect(grip).not.toBeNull();
  const x = grip!.x + grip!.width / 2;
  const y = grip!.y + grip!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: 10 });
  await page.mouse.up();
}

async function checkScrolling(page: Page, dialog: Locator) {
  const body = dialog.locator("[data-dialog-body]");
  const list = dialog.getByRole("tree", { name: "Run configurations", exact: true });
  const form = dialog.locator('[class*="_editForm_"]');
  await list.evaluate((el) => (el.scrollTop = 0));
  await form.evaluate((el) => (el.scrollTop = 0));
  await list.hover();
  await page.mouse.wheel(0, 200);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await form.evaluate((el) => el.scrollTop)).toBe(0);
  const listTop = await list.evaluate((el) => el.scrollTop);
  await form.hover();
  await page.mouse.wheel(0, 200);
  await expect.poll(() => form.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await list.evaluate((el) => el.scrollTop)).toBe(listTop);
  const overflow = await body.evaluate((el) => ({
    scroll: el.scrollHeight,
    client: el.clientHeight,
    top: el.scrollTop,
  }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
  expect(overflow.top).toBe(0);
  await expect(dialog.getByRole("toolbar", { name: "Configurations" })).toBeInViewport({ ratio: 1 });
  for (const name of ["Run", "Debug", "Cancel", "Apply", "OK"]) {
    await expect(dialog.locator("[data-dialog-footer]").getByRole("button", { name, exact: true })).toBeInViewport({
      ratio: 1,
    });
  }
}
