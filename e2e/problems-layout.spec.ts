import { expect, test } from "./fixtures";

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
