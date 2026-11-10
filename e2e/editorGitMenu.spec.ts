import { expect, openFromTree, test } from "./fixtures";

test("editor Git submenu offers the registered file and repository actions in groups", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "README.md");
  await editor.locator(".cm-content").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Git", exact: true }).hover();
  const git = page.getByRole("menu").filter({ has: page.getByRole("menuitem", { name: "Clone…", exact: true }) });
  await expect(git.locator('[role="menuitem"], [role="menuitemcheckbox"]')).toHaveText([
    /Commit File…/,
    /Add/,
    /Annotate with Git Blame/,
    /Show Diff/,
    /Compare with Branch or Revision…/,
    /Compare with Revision…/,
    /Show History$/,
    /Show Current Revision/,
    /Show History for Selection/,
    /Rollback…/,
    /Push…/,
    /Pull…/,
    /Fetch/,
    /Merge…/,
    /Rebase…/,
    /Branches…/,
    /New Branch…/,
    /New Tag…/,
    /Reset HEAD…/,
    /Stash Changes…/,
    /Unstash Changes…/,
    /GitHub/,
    /Manage Remotes…/,
    /Clone…/,
  ]);
  await expect(git.getByRole("separator")).toHaveCount(6);
  await git.getByRole("menuitem", { name: "GitHub", exact: true }).hover();
  for (const name of ["View Pull Requests", "Create Pull Request…", "Checkout Pull Request…", "Open on GitHub"]) {
    await expect(page.getByRole("menuitem", { name: new RegExp(`^${name}`) })).toBeEnabled();
  }
});

test("editor Git submenu keeps repository actions disabled without Git", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "README.md");
  await page.evaluate(async () => {
    const projectModule = "/src/platform/project.ts";
    const contextModule = "/src/platform/context.ts";
    const { useProject } = await import(/* @vite-ignore */ projectModule);
    const { setContext } = await import(/* @vite-ignore */ contextModule);
    useProject.setState((s: { project: object }) => ({ project: { ...s.project, isGit: false } }));
    setContext("vcsAvailable", false);
  });
  await editor.locator(".cm-content").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Git", exact: true }).hover();
  for (const name of [
    "Merge…",
    "Rebase…",
    "New Branch…",
    "New Tag…",
    "Reset HEAD…",
    "Stash Changes…",
    "Unstash Changes…",
    "Manage Remotes…",
  ]) {
    await expect(page.getByRole("menuitem", { name: new RegExp(`^${name}`) })).toBeDisabled();
  }
  await expect(page.getByRole("menuitem", { name: "Clone…", exact: true })).toBeEnabled();
});
