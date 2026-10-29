/** Linux browser acceptance: synthetic MemoryFs + mocked native IPC, real menu/action/refresh UI. */
import { expect, test } from "./fixtures";

for (const destination of ["gitignore", "localExclude"] as const) {
  test(`ignore ${destination}: menu dispatch and immediate tree/status refresh`, async ({ workbench: page }) => {
    await page.evaluate(async (destination) => {
      const fsModule = "/src/features/project-tree/fs.ts";
      const storeModule = "/src/features/project-tree/store.ts";
      const ipcModule = "/src/platform/ipc.ts";
      const { projectFs } = await import(fsModule);
      const { reloadAll } = await import(storeModule);
      const { commands } = await import(ipcModule);
      const root = "/dev/acme-api";
      const path = `${root}/scratch.log`;
      const fs = projectFs(root);
      await fs.createFile(path);
      let written = false;
      commands.vcsAddToIgnore = async (paths: string[], actual: string) => {
        if (actual !== destination || paths.length !== 1 || paths[0] !== path)
          throw new Error("Wrong ignore destination or paths");
        written = true;
        fs.ignored.add(path);
        return { status: "ok", data: null };
      };
      commands.vcsStatus = async () => {
        document.body.dataset.ignoreStatusRefresh = written ? "after-write" : "before-write";
        return {
          status: "ok",
          data: written
            ? []
            : [{ path, relPath: "scratch.log", staged: null, unstaged: "untracked", renamedFrom: null }],
        };
      };
      commands.vcsRoots = async () => ({
        status: "ok",
        data: [{ root, operation: null, head: "main", headCommit: null }],
      });
      commands.vcsBranchInfo = async () => ({
        status: "ok",
        data: { head: "main", headCommit: null, upstream: null, ahead: 0, behind: 0, operation: null },
      });
      const vcsModule = "/src/features/vcs/store.ts";
      const { useVcs } = await import(vcsModule);
      useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
      await reloadAll();
      const banner = document.createElement("div");
      banner.textContent = "LINUX BROWSER E2E · SYNTHETIC FIXTURE · NATIVE IPC MOCKED";
      Object.assign(banner.style, {
        position: "fixed",
        bottom: "28px",
        right: "18px",
        zIndex: "999999",
        padding: "10px 14px",
        background: "#fff4ce",
        color: "#362a00",
        font: "bold 12px sans-serif",
        border: "1px solid #9e8500",
        borderRadius: "5px",
      });
      document.body.append(banner);
    }, destination);
    await page.getByRole("treeitem", { name: "scratch.log", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Git", exact: true }).hover();
    await page.getByRole("menuitem", { name: "Add to .gitignore", exact: true }).hover();
    await expect(page.getByRole("menuitem", { name: ".gitignore", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: ".git/info/exclude", exact: true })).toBeVisible();
    const captureDir = process.env.OPENIDEA_ACCEPTANCE_DIR;
    if (captureDir && destination === "gitignore")
      await page.screenshot({ path: `${captureDir}/01-ignore-destinations.png` });
    await page
      .getByRole("menuitem", { name: destination === "gitignore" ? ".gitignore" : ".git/info/exclude", exact: true })
      .click();
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const module = "/src/features/project-tree/store.ts";
          const { useProjectTree } = await import(module);
          return useProjectTree
            .getState()
            .listings.get("/dev/acme-api")
            ?.find((entry: { name: string }) => entry.name === "scratch.log")?.ignored;
        }),
      )
      .toBe(true);
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const module = "/src/features/vcs/store.ts";
          const { useVcs } = await import(module);
          return useVcs.getState().status.length;
        }),
      )
      .toBe(0);
    await expect(page.locator("body")).toHaveAttribute("data-ignore-status-refresh", "after-write");
    // Display fixture rule text in the actual editor. This is browser memory, not a native disk read.
    await page.evaluate(async (destination) => {
      const module = "/src/workbench/contributions.ts";
      const { editorService } = await import(module);
      await editorService().openFile(
        `/dev/acme-api/${destination === "gitignore" ? ".gitignore" : ".git/info/exclude"}`,
        { focus: true },
      );
    }, destination);
    const content = page.locator(".cm-editor .cm-content").first();
    await content.fill(
      `# Synthetic acceptance fixture: ${destination === "gitignore" ? "shared repository rules" : ".git/info/exclude: local rules (common to linked worktrees)"}\n/scratch.log\n`,
    );
    if (captureDir)
      await page.screenshot({
        path: `${captureDir}/${destination === "gitignore" ? "02-shared-ignore-effect" : "03-local-exclude-effect"}.png`,
      });
  });
}
