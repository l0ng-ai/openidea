import { expect, test } from "./fixtures";

test("Welcome keeps project search and actions on one row at a narrow width", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1080, height: 700 });
  await page.evaluate(async () => {
    const projectPath = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ projectPath);
    useProject.setState({ project: null, lightEdit: false });
  });

  const projects = page.getByRole("region", { name: "Projects", exact: true });
  const search = projects.getByRole("textbox", { name: "Search projects" });
  const list = projects.getByRole("listbox", { name: "Recent projects" });
  const more = projects.getByRole("button", { name: "More Actions", exact: true });
  const open = projects.getByRole("button", { name: "Open", exact: true });
  await expect(list.getByRole("option")).toHaveCount(4);
  await expect(more).toBeVisible();
  await expect(open).toHaveText("Open");

  await page.setViewportSize({ width: 440, height: 620 });
  const boxes = await Promise.all([search.boundingBox(), open.boundingBox(), more.boundingBox()]);
  expect(boxes[0]!.width).toBeGreaterThan(95);
  for (const box of boxes.slice(1)) {
    expect(Math.abs(box!.y + box!.height / 2 - (boxes[0]!.y + boxes[0]!.height / 2))).toBeLessThan(2);
    expect(box!.x + box!.width).toBeLessThanOrEqual(440);
  }
  await expect(open.getByText("Open", { exact: true })).toBeHidden();
  await expect.poll(() => projects.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);

  await search.fill("tokio");
  await expect(list.getByRole("option")).toHaveCount(1);
  await expect(list.getByRole("option")).toContainText("tokio");
  await more.press("Enter");
  const menu = page.getByRole("menu", { name: "More Actions" });
  for (const label of ["New File", "Open File", "Remote Development"]) {
    await expect(menu.getByRole("menuitem", { name: new RegExp(label) })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
  await expect(search).toHaveValue("tokio");
});
