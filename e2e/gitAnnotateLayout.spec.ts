import { expect, openFromTree, stubDesktop, test } from "./fixtures";

test("Git annotations align dates and full author names at UI text size", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  const longEmail = `reconciliation+${"regional-settlement-".repeat(5)}review@example.invalid`;
  await page.evaluate(async (email) => {
    const root = "/dev/acme-api";
    const file = `${root}/build.gradle.kts`;
    const handlers = window.__ipc.handlers;
    const lines = [
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
    handlers.vcs_blame = () => lines;
    handlers.vcs_log = ({ query }) => {
      const { branch } = query as { branch?: string };
      const line = lines.find(({ commit }) => commit === branch);
      if (!line) return [];
      return [
        {
          ...line,
          id: line.commit,
          shortId: line.commit.slice(0, 8),
          refs: [],
          parents: [],
          email: line === lines[0] ? "lena@example.invalid" : email,
          message: line.summary,
        },
      ];
    };
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
  }, longEmail);

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

  await first.hover();
  const details = page.getByRole("dialog").filter({ has: page.getByTitle("Show Commit in Git Log") });
  await expect(details).toContainText("lena@example.invalid");
  await expect.poll(async () => (await details.boundingBox())!.width).toBeLessThan(400);
  await expect(details.getByTitle("Show Commit in Git Log")).toHaveCSS(
    "font-family",
    await details.evaluate((el) => getComputedStyle(el).fontFamily),
  );

  await page.setViewportSize({ width: 430, height: 640 });
  await second.hover();
  await expect(details).toContainText(longEmail);
  await expect(details).toBeInViewport({ ratio: 1 });
  await expect.poll(() => details.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
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
