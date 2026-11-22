import { expect, test } from "./fixtures";

test("Background Tasks keeps task details and actions reachable while resizing and scrolling", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.evaluate(() => {
    window.addEventListener("error", (event) => {
      if (event.message.includes("ResizeObserver loop")) document.body.dataset.taskResizeError = event.message;
    });
  });
  const title = "Synchronizing the settlement service and reconciliation workspace";
  const message = "Reading the payment service dependencies and refreshing the reconciliation workspace model.";
  await page.evaluate(
    async ({ title, message }) => {
      const path = "/src/workbench/tasks.ts";
      const { upsertTask, removeTask } = await import(/* @vite-ignore */ path);
      upsertTask({ id: "refresh", title: "Refreshing project files", message: null, fraction: null, done: false });
      upsertTask({ id: "sync", title, message, fraction: 0.42, done: false, cancel: () => removeTask("sync") });
    },
    { title, message },
  );

  const status = page.getByRole("button", { name: `Background tasks: ${title}` });
  await status.click();
  const popup = page.getByRole("dialog", { name: "Background tasks", exact: true });
  const resize = popup.getByRole("separator", { name: "Resize" });
  await expect(resize).toBeVisible();
  const initial = (await popup.boundingBox())!;
  const corner = (await resize.boundingBox())!;
  const x = corner.x + corner.width / 2;
  const y = corner.y + corner.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 48, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await popup.boundingBox())!.width).toBeGreaterThan(initial.width + 32);
  const size = (await popup.boundingBox())!;
  expect(size.height).toBeGreaterThan(initial.height + 24);
  await popup.getByRole("button", { name: "Close", exact: true }).click();
  await expect(popup).toBeHidden();
  await status.click();
  await expect.poll(async () => (await popup.boundingBox())!.width).toBeCloseTo(size.width, 0);
  await expect.poll(async () => (await popup.boundingBox())!.height).toBeCloseTo(size.height, 0);

  await page.evaluate(async () => {
    const path = "/src/workbench/tasks.ts";
    const { upsertTask } = await import(/* @vite-ignore */ path);
    for (let i = 1; i <= 10; i++) {
      upsertTask({
        id: `check-${i}`,
        title: `Checking workspace module ${i}`,
        message: "Reading source files",
        fraction: null,
        done: false,
      });
    }
  });
  await page.setViewportSize({ width: 400, height: 430 });
  await expect(popup).toBeInViewport({ ratio: 1 });
  const list = popup.getByRole("list", { name: "Background Tasks" });
  const sync = list.getByRole("listitem").filter({ hasText: title });
  const detail = sync.getByText(message, { exact: true });
  expect(await detail.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  const [detailBox, progressBox] = await Promise.all([
    detail.boundingBox(),
    sync.getByRole("progressbar", { name: title }).boundingBox(),
  ]);
  expect(progressBox!.y).toBeGreaterThan(detailBox!.y + detailBox!.height);
  expect(
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    }),
  ).toBeGreaterThan(0);
  await expect(popup.getByRole("heading", { name: "Background Tasks" })).toBeInViewport({ ratio: 1 });
  await sync.getByRole("button", { name: `Cancel ${title}` }).click();
  await expect(sync).toHaveCount(0);
  await expect(popup).toBeVisible();

  await page.evaluate(async () => {
    const path = "/src/workbench/tasks.ts";
    const { useTasks, removeTask } = await import(/* @vite-ignore */ path);
    for (const task of useTasks.getState().tasks) removeTask(task.id);
  });
  await expect(popup).toBeHidden();
  expect(await page.locator("body").getAttribute("data-task-resize-error")).toBeNull();
});
