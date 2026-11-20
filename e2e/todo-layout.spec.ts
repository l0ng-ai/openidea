import { expect, test } from "./fixtures";

test("keeps the file count visible beside a long directory in the TODO pane", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 900, height: 760 });
  await page.evaluate(async () => {
    const projectModule = "/src/platform/project.ts";
    const todoModule = "/src/features/todo/store.ts";
    const { useProject } = await import(/* @vite-ignore */ projectModule);
    const { useTodos } = await import(/* @vite-ignore */ todoModule);
    const directory = "src/features/checkout/shared/services/with-a-long-directory-name/for-order-processing";
    const path = `${useProject.getState().project.root}/${directory}/orders.ts`;
    useTodos.setState({
      scannedOnce: true,
      error: null,
      scanned: new Map([[path, [{ path, line: 8, col: 3, keyword: "TODO", text: "TODO: validate orders" }]]]),
    });
  });

  await page.getByRole("button", { name: "TODO" }).click();
  const pane = page.locator('[data-toolwindow="todo"]');
  const toolbar = pane.getByRole("toolbar", { name: "TODO actions" });
  await expect(toolbar).toHaveAttribute("aria-orientation", "vertical");
  const tree = pane.getByRole("tree", { name: "TODO items" });
  const fileName = tree.getByText("orders.ts", { exact: true });
  await expect(fileName).toBeVisible();
  await expect.poll(() => fileName.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const count = tree.getByText("1 item", { exact: true });
  await expect(count).toBeVisible();
  await expect
    .poll(() =>
      count.evaluate(
        (element) =>
          element.getBoundingClientRect().right <= element.closest('[role="tree"]')!.getBoundingClientRect().right,
      ),
    )
    .toBe(true);
});
