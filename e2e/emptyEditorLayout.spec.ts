import { expect, test } from "./fixtures";

test("empty editor hints form a readable block and reveal the Project shortcut when needed", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  const hints = page.locator("[data-editor-area] dl");
  const project = hints.getByRole("button", { name: "Project", exact: true });
  await expect(hints).toBeVisible();
  await expect(hints).toHaveCSS("font-size", "16px");
  await expect(project).toBeHidden();
  const rowLefts = await hints.locator("dt").evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().left));
  expect(new Set(rowLefts).size).toBe(1);
  const bounds = await hints.evaluate((element) => {
    const area = element.parentElement!.getBoundingClientRect();
    const block = element.getBoundingClientRect();
    const first = element.querySelector("dt")!.getBoundingClientRect();
    return {
      center: Math.abs(block.left + block.width / 2 - (area.left + area.width / 2)),
      topRatio: (first.top - area.top) / area.height,
    };
  });
  expect(bounds.center).toBeLessThan(1);
  expect(bounds.topRatio).toBeGreaterThan(0.31);
  expect(bounds.topRatio).toBeLessThan(0.39);

  await page.locator('[data-stripe-button="project"]').click();
  await expect(project).toBeVisible();
  await expect(project.locator("xpath=../../dd")).not.toBeEmpty();
  await project.click();
  await expect(page.getByRole("region", { name: "Project", exact: true })).toBeVisible();
  await expect(project).toBeHidden();

  await page.setViewportSize({ width: 400, height: 360 });
  await expect(project).toBeVisible();
  await expect(hints.getByText("Drop files here to open them", { exact: true })).toBeInViewport({ ratio: 1 });
  expect(await hints.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await hints.getByRole("button", { name: "Search Everywhere", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Search Everywhere" })).toBeVisible();
});

test("the empty LightEdit window keeps its file actions at the same readable size", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 400, height: 360 });
  await page.evaluate(async () => {
    const path = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ path);
    useProject.setState({ project: null, lightEdit: true });
  });
  const hints = page.locator("[data-editor-area] dl");
  await expect(hints).toHaveCSS("font-size", "16px");
  await expect(hints.locator("dt")).toHaveText(["New File", "Open File", "Drop files here to open them"]);
  await expect(hints.getByRole("button", { name: "Open File", exact: true })).toBeInViewport({ ratio: 1 });
});
