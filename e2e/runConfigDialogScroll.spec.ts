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
        kind: "npm",
        command: "yarn",
        args: ["run", `script-${i}`],
        packageManager: "yarn",
        cwd: null,
        env: {},
        detected: false,
        isTest: false,
        debugAdapter: "js-debug",
      }));
      useRun.setState({ configs, loaded: true, editorOpen: true, editTarget: "cfg-30" });
    });
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const body = dialog.locator("[data-dialog-body]");
    await body.hover();
    await page.mouse.wheel(0, 200);
    const overflow = await body.evaluate((el) => ({
      scroll: el.scrollHeight,
      client: el.clientHeight,
      top: el.scrollTop,
    }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
    expect(overflow.top).toBe(0);
    await expect(dialog.getByRole("toolbar", { name: "Configurations" })).toBeInViewport({ ratio: 1 });
  });
}
