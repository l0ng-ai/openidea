import { expect, test } from "./fixtures";

test("Welcome matches IDEA Home layout and adapts cleanly to narrow widths", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1080, height: 700 });
  await page.evaluate(async () => {
    const projectPath = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ projectPath);
    useProject.setState({ project: null, lightEdit: false });
  });

  const projects = page.getByRole("region", { name: "Projects and Files", exact: true });
  const search = projects.getByRole("textbox", { name: "Search projects" });
  const list = projects.getByRole("listbox", { name: "Recent projects" });
  const open = projects.getByRole("button", { name: "Open", exact: true });
  const newBtn = projects.getByRole("button", { name: "New", exact: true });
  await expect(projects).toBeVisible();
  await expect(list.getByRole("option")).toHaveCount(4);
  await expect(open).toBeVisible();
  await expect(newBtn).toBeVisible();
  await expect(projects.getByRole("button", { name: "Clone Repository", exact: true })).toBeVisible();
  await expect(projects.getByRole("button", { name: "Remote Development", exact: true })).toBeVisible();

  const workspace = page.getByRole("region", { name: "Workspace", exact: true });
  await expect(workspace.getByRole("button", { name: "New Markdown File", exact: true })).toBeVisible();
  await expect(workspace.getByRole("button", { name: "Open File", exact: true })).toBeVisible();
  await expect(workspace.getByRole("button", { name: "Open Terminal", exact: true })).toBeVisible();
  await expect(workspace.getByRole("button", { name: "Plugins", exact: true })).toBeVisible();
  await expect(workspace.getByRole("button", { name: /^Theme:/ })).toBeVisible();
  await expect(workspace.getByRole("button", { name: /^Keymap:/ })).toBeVisible();

  await newBtn.click();
  const newMenu = page.getByRole("menu", { name: "New" });
  for (const label of ["New Project…", "New File", "New Markdown File", "New Project Group…"]) {
    await expect(newMenu.getByRole("menuitem", { name: label })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(newMenu).toBeHidden();

  // Collapse and restore Projects and Files.
  await projects.getByRole("button", { name: "Hide", exact: true }).click();
  await expect(projects).toBeHidden();
  await page
    .getByRole("complementary", { name: "Left tool window stripe" })
    .getByRole("button", { name: "Projects and Files", exact: true })
    .click();
  await expect(projects).toBeVisible();

  // Narrow window keeps Projects and Files full-width with zero horizontal overflow.
  await page.setViewportSize({ width: 440, height: 620 });
  const [searchBox, openBox] = await Promise.all([search.boundingBox(), open.boundingBox()]);
  expect(searchBox!.width).toBeGreaterThan(150);
  expect(openBox!.x + openBox!.width).toBeLessThanOrEqual(440);
  await expect.poll(() => projects.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);

  await search.fill("tokio");
  await expect(list.getByRole("option")).toHaveCount(1);
  await expect(list.getByRole("option")).toContainText("tokio");
});
