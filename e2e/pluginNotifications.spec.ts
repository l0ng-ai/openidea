import { expect, test } from "./fixtures";

test("plugin notification actions run their command and dismiss the balloon", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const backendPath = "/src/features/plugins/backend.ts";
    const { createMemoryPluginsBackend, setPluginsBackend } = await import(/* @vite-ignore */ backendPath);
    const state = window as unknown as { notificationCalls: unknown[] };
    state.notificationCalls = [];
    setPluginsBackend({
      ...createMemoryPluginsBackend(),
      runCommand: async (...args: unknown[]) => {
        state.notificationCalls.push(args);
        return null;
      },
    });
    const bridgePath = "/src/features/plugins/bridge.ts";
    const { handlePluginEvent } = await import(/* @vite-ignore */ bridgePath);
    handlePluginEvent({
      type: "notification",
      pluginId: "hello",
      level: "info",
      title: "Build complete",
      body: "Choose the next step",
      actions: [
        { label: "Review changes", command: "word-count", argument: "first\nsecond" },
        { label: "Open results", command: "insert-date", argument: null },
        { label: "Undo change", command: "insert-date", argument: "undo" },
      ],
    });
  });
  const review = page.getByRole("button", { name: "Review changes", exact: true });
  await expect(review).toBeVisible();
  await expect(page.getByRole("button", { name: "Open results", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo change", exact: true })).toBeVisible();
  await review.click();
  await expect(review).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { notificationCalls: unknown[] }).notificationCalls))
    .toEqual([["hello", "word-count", "first\nsecond", null, []]]);
});
