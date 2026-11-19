import { expect, test } from "./fixtures";

test("gives the project name room before its path in a narrow tree", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const storeModule = "/src/features/project-tree/store.ts";
    const { useProjectTree } = await import(/* @vite-ignore */ storeModule);
    useProjectTree.setState({ name: "checkout-order-processing" });
  });

  const pane = page.getByRole("region", { name: "Project", exact: true });
  await pane.getByRole("button", { name: "Options", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Horizontal Scrolling" }).click();

  const tree = pane.getByRole("tree", { name: "Project" });
  const name = tree.getByText("checkout-order-processing", { exact: true });
  await expect(name).toBeVisible();
  await expect.poll(() => name.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect.poll(() => tree.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});
