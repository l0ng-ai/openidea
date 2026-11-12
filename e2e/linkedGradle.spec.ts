/** Linked Gradle builds use isolated native stubs; no real builds or files are touched. */
import type { GradleModel, RunConfig } from "../src/platform/ipc";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const build = (dir: string): GradleModel => ({
  dir,
  command: `/dev/acme-api/${dir}/gradlew`,
  env: { JAVA_HOME: `/${dir}/jdk` },
  javaVersion: 21,
  syncedAt: 1,
  stale: false,
  syncError: null,
  projects: [
    { path: ":", name: dir, dir, buildFile: `${dir}/build.gradle`, tasks: [] },
    {
      path: ":app",
      name: "app",
      dir: `${dir}/app`,
      buildFile: `${dir}/app/build.gradle`,
      tasks: [{ name: "assemble", group: "build", description: "Assembles this project" }],
    },
  ],
});

test("links independent Gradle roots, runs identical task paths in their own builds and unlinks without deletion", async ({
  workbench: page,
}, info) => {
  await stubDesktop(page);
  await page.evaluate(
    async ({ first, second }) => {
      let linked = [first];
      let runId = 0;
      const model = () => ({ maven: null, gradle: linked });
      const h = window.__ipc.handlers;
      h.build_model = model;
      h.build_sync = model;
      h.run_configs = () => [];
      h.run_apply_settings = (args) => args.configs;
      h.gradle_link_projects = () => {
        if (!linked.some((g) => g.dir === second.dir)) linked = [...linked, second];
        return model();
      };
      h.gradle_unlink_projects = (args) => {
        linked = linked.filter((g) => !(args.paths as string[]).includes(g.dir));
        return model();
      };
      h["plugin:dialog|open"] = () => ["/dev/acme-api/second/settings.gradle"];
      h.run_start = (args) => {
        const config = args.config as RunConfig;
        const id = ++runId;
        setTimeout(() => window.__ipc.emit({ type: "runExited", run: id, code: 0 }), 50);
        return { id, configId: config.id, name: config.name, pid: 4242 + id, running: true, pty: false };
      };
      const storeModule = "/src/features/build-tools/store.ts";
      const { loadModel } = await import(/* @vite-ignore */ storeModule);
      await loadModel();
      const contributionsModule = "/src/workbench/contributions.ts";
      const { toolWindowService } = await import(/* @vite-ignore */ contributionsModule);
      toolWindowService().show("gradle", true);
    },
    { first: build("first"), second: build("second") },
  );

  const tree = page.getByRole("tree", { name: "Gradle projects" });
  await expect(tree.getByRole("treeitem", { name: "first", exact: true })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "second", exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("gradle-one-root.png"), animations: "disabled" });

  await page.getByRole("button", { name: "Link Gradle Projects", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "gradle_link_projects"))
    .toEqual([{ paths: ["/dev/acme-api/second/settings.gradle"] }]);
  await expect(tree.getByRole("treeitem", { name: "second", exact: true })).toBeVisible();
  // Reloading the model reads the persisted linkage again.
  await page.evaluate(async () => {
    const storeModule = "/src/features/build-tools/store.ts";
    const { loadModel } = await import(/* @vite-ignore */ storeModule);
    await loadModel();
    const actionModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionModule);
    await executeAction("gradle.expandAll");
    await executeAction("gradle.toggleOffline");
  });
  const tasks = tree.getByRole("treeitem", { name: /^assemble\b/ });
  await expect(tasks).toHaveCount(2);
  await page.screenshot({ path: info.outputPath("gradle-two-roots.png"), animations: "disabled" });

  await tasks.nth(0).dblclick();
  await expect.poll(async () => (await ipcCalls(page, "run_start")).length).toBe(1);
  await tasks.nth(1).dblclick();
  await expect.poll(async () => (await ipcCalls(page, "run_start")).length).toBe(2);
  const runs = (await ipcCalls(page, "run_start")).map((args) => args.config as RunConfig);
  expect(runs[0]!.id).not.toBe(runs[1]!.id);
  for (const [index, dir] of ["first", "second"].entries()) {
    expect(runs[index]).toMatchObject({
      command: `/dev/acme-api/${dir}/gradlew`,
      cwd: dir,
      args: [":app:assemble", "--offline"],
      // The build's `JAVA_HOME` is Settings-derived: the launcher resolves it instead of the
      // task configuration freezing the one the model had when the tree was built (#2433).
      env: {},
    });
  }

  for (const dir of ["second", "first"]) {
    await tree.getByRole("treeitem", { name: dir, exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Unlink Gradle Project", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Unlink Gradle project?" });
    await expect(dialog).toContainText("Files will remain");
    await dialog.getByRole("button", { name: "Unlink", exact: true }).click();
    await expect(tree.getByRole("treeitem", { name: dir, exact: true })).toHaveCount(0);
  }
  await expect
    .poll(() => ipcCalls(page, "gradle_unlink_projects"))
    .toEqual([{ paths: ["second"] }, { paths: ["first"] }]);
  await expect(page.getByText("No Gradle projects", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Link Gradle Projects", exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => window.__ipc.calls.filter((c) => /^fs_(?:delete|remove|trash)/.test(c.cmd))),
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath("gradle-unlinked.png"), animations: "disabled" });
});
