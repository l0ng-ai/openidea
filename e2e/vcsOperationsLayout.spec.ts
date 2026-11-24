import { expect, openFromTree, test } from "./fixtures";

test("VCS Operations keeps its centered title visible in a short window", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 640, height: 320 });
  const editor = await openFromTree(page, "README.md");
  const content = editor.locator(".cm-content");
  await content.focus();
  await page.evaluate(async () => {
    const actions = "/src/platform/actions.ts";
    await (await import(/* @vite-ignore */ actions)).executeAction("vcs.operations");
  });

  const menu = page.getByRole("menu", { name: "VCS Operations", exact: true });
  const popup = menu.locator("..");
  const title = popup.getByText("VCS Operations", { exact: true });
  await expect(title).toHaveCSS("font-size", "13px");
  await expect(title).toHaveCSS("font-weight", "600");
  await expect
    .poll(async () => {
      const box = (await popup.boundingBox())!;
      return Math.max(Math.abs(box.x + box.width / 2 - 320), Math.abs(box.y + box.height / 2 - 160));
    })
    .toBeLessThan(2);
  const commit = menu.getByRole("menuitem", { name: /^Commit…/ });
  await expect(commit).toBeFocused();
  await expect(commit.locator('[data-menu-number="1"]')).toBeVisible();
  await page.keyboard.press("End");
  const history = menu.getByRole("menuitem", { name: /^Show Local History/ });
  await expect(history).toBeFocused();
  await expect(history).toBeInViewport({ ratio: 1 });
  await expect.poll(() => popup.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect((await title.boundingBox())!.y).toBeGreaterThanOrEqual((await popup.boundingBox())!.y);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(content).toBeFocused();

  await page.evaluate(async () => {
    const actions = "/src/platform/actions.ts";
    await (await import(/* @vite-ignore */ actions)).executeAction("vcs.operations");
  });
  await expect(commit).toBeFocused();
  await page.keyboard.press("1");
  await expect(menu).toBeHidden();
  const commitWindow = page.getByRole("region", { name: "Commit", exact: true });
  await expect(commitWindow).toBeVisible();
  const message = commitWindow.getByRole("textbox", { name: "Commit message" });
  await expect(message).toBeFocused();
  expect(await message.evaluate((el) => (el instanceof HTMLTextAreaElement ? el.value : el.textContent))).toBe("");
});

test("VCS Operations offers repository setup and Local History outside Git", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "README.md");
  await editor.locator(".cm-content").focus();
  await page.evaluate(async () => {
    const project = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ project);
    useProject.setState((s: { project: object }) => ({ project: { ...s.project, isGit: false } }));
    const context = "/src/platform/context.ts";
    (await import(/* @vite-ignore */ context)).setContext("vcsAvailable", false);
    const actions = "/src/platform/actions.ts";
    await (await import(/* @vite-ignore */ actions)).executeAction("vcs.operations");
  });

  const menu = page.getByRole("menu", { name: "VCS Operations", exact: true });
  await expect(menu.getByRole("menuitem")).toHaveText([/Create Git Repository…/, /Show Local History/]);
  await expect(menu.getByRole("menuitem", { name: /^Create Git Repository…/ })).toBeFocused();
});
