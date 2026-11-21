import { expect, openFromTree, stubDesktop, test } from "./fixtures";

test("Git annotations align dates and full author names at UI text size", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.evaluate(async () => {
    const root = "/dev/acme-api";
    const file = `${root}/build.gradle.kts`;
    const handlers = window.__ipc.handlers;
    handlers.vcs_blame = () => [
      {
        commit: "a1234567".padEnd(40, "a"),
        author: "Lena Park",
        timeMs: Date.UTC(2026, 4, 3, 12),
        summary: "Update totals",
      },
      {
        commit: "b1234567".padEnd(40, "b"),
        author: "Lena Ortiz",
        timeMs: Date.UTC(2026, 8, 23, 12),
        summary: "Review totals",
      },
    ];
    const projectModule = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ projectModule);
    const { settings } = useProject.getState();
    useProject.setState({
      settings: {
        ...settings,
        general: { ...settings?.general, dateFormat: { overrideSystem: true, pattern: "d MMMM yyyy" } },
      },
    });
    const storeModule = "/src/features/vcs/store.ts";
    const { useVcs } = await import(/* @vite-ignore */ storeModule);
    useVcs.setState({ available: true, root, repo: root, roots: [root] });
    const contextModule = "/src/platform/context.ts";
    const { setContext } = await import(/* @vite-ignore */ contextModule);
    setContext("vcsAvailable", true);
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    await executeAction("vcs.annotate", file);
  });

  const gutter = editor.locator(".cm-vcs-blame");
  const first = gutter.locator("[data-commit]").filter({ hasText: "3 May 2026" });
  const second = gutter.locator("[data-commit]").filter({ hasText: "23 September 2026" });
  const firstAuthor = first.locator(".cm-vcs-blame-author");
  const secondAuthor = second.locator(".cm-vcs-blame-author");
  await expect(firstAuthor).toHaveText("Lena Park");
  await expect(secondAuthor).toHaveText("Lena Ortiz");
  await expect
    .poll(async () => Math.abs((await firstAuthor.boundingBox())!.x - (await secondAuthor.boundingBox())!.x))
    .toBeLessThan(1);
  const uiSize = await editor.evaluate((el) => getComputedStyle(el).getPropertyValue("--fs-ui").trim());
  await expect(firstAuthor).toHaveCSS("font-size", uiSize);

  const firstRevision = first.locator(".cm-vcs-blame-revision");
  await expect(firstRevision).toBeHidden();
  await second.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Options", exact: true }).hover();
  await page.getByRole("menuitemcheckbox", { name: "Revision", exact: true }).click();
  await expect(firstRevision).toBeVisible();
  expect((await firstRevision.boundingBox())!.x).toBeLessThan(
    (await first.locator(".cm-vcs-blame-date").boundingBox())!.x,
  );
  await expect
    .poll(async () => Math.abs((await firstAuthor.boundingBox())!.x - (await secondAuthor.boundingBox())!.x))
    .toBeLessThan(1);
});
