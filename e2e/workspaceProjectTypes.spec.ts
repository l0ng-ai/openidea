import { expect, stubDesktop, test } from "./fixtures";

test.use({ video: "on" });

test("detects collapsed workspace projects and sorts them by framework, then name", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const files: Record<string, string> = {
      "/work/z-web/package.json": JSON.stringify({ devDependencies: { "@sveltejs/kit": "2" } }),
      "/work/a-go/go.mod": "module example.test/a\ngo 1.26\n",
      "/work/z-go/go.mod": "module example.test/z\ngo 1.26\n",
      "/work/dashboard/package.json": JSON.stringify({ dependencies: { react: "19", next: "16" } }),
      "/work/site/package.json": JSON.stringify({ devDependencies: { vite: "8" } }),
      "/work/mobile/pubspec.yaml": "name: mobile\ndependencies:\n  flutter:\n    sdk: flutter\n",
      "/work/shared/build.gradle.kts": 'plugins { id("org.jetbrains.compose"); kotlin("multiplatform") }',
      "/work/api/build.gradle.kts": 'plugins { id("io.quarkus") }',
      "/work/notes/README.md": "Notes",
    };
    window.__ipc.handlers.fs_read_dir = ({ path }) =>
      Object.keys(files)
        .filter((p) => p.slice(0, p.lastIndexOf("/")) === path)
        .map((p) => ({
          path: p,
          name: p.slice(p.lastIndexOf("/") + 1),
          kind: "file",
          size: files[p]!.length,
          mtimeMs: 0,
          ignored: false,
          excluded: false,
          hidden: false,
        }));
    window.__ipc.handlers.fs_read_text = ({ path }) => {
      if (typeof path !== "string" || !(path in files)) throw new Error("Not found");
      return files[path];
    };
    const module = "/src/features/project-tree/store.ts";
    const { initProjectTree, useProjectTree } = await import(/* @vite-ignore */ module);
    initProjectTree("/workspace", "Workspace", [
      "/work/z-web",
      "/work/a-go",
      "/work/mobile",
      "/work/shared",
      "/work/api",
      "/work/z-go",
      "/work/notes",
      "/work/dashboard",
      "/work/site",
    ]);
    useProjectTree.setState({ expanded: new Set() });
  });
  const tree = page.getByRole("tree", { name: "Project" });
  const shape = async (icon: string) =>
    page.evaluate(async (name) => {
      const module = "/src/ui/icons.tsx";
      const { iconMarkup } = await import(/* @vite-ignore */ module);
      return new DOMParser()
        .parseFromString(iconMarkup(name)!, "image/svg+xml")
        .querySelector("path")!
        .getAttribute("d");
    }, icon);
  for (const [name, icon] of [
    ["z-web", "project-svelte"],
    ["a-go", "file-go"],
    ["mobile", "project-flutter"],
    ["shared", "project-compose"],
    ["api", "project-quarkus"],
    ["notes", "module"],
    ["dashboard", "project-nextjs"],
    ["site", "project-vite"],
  ]) {
    const row = tree.locator(`[data-project-path="/work/${name}"]`);
    await expect(row.locator("svg path").first()).toHaveAttribute("d", (await shape(icon!))!);
    await expect(row.locator("[data-project-path]")).toHaveCount(0);
  }
  await page
    .getByRole("region", { name: "Project", exact: true })
    .getByRole("button", { name: "Options", exact: true })
    .click();
  await page.getByRole("menuitemcheckbox", { name: "Sort by Type", exact: true }).click();
  await expect(tree.locator("[data-project-path]")).toHaveText([
    "shared/work/shared",
    "mobile/work/mobile",
    "a-go/work/a-go",
    "z-go/work/z-go",
    "dashboard/work/dashboard",
    "api/work/api",
    "z-web/work/z-web",
    "site/work/site",
    "notes/work/notes",
  ]);
  await page.evaluate(async () => {
    window.__ipc.handlers.fs_read_text = () => JSON.stringify({ dependencies: { react: "19" } });
    window.__ipc.emit({ type: "fsChanged", created: [], modified: ["/work/z-web/package.json"], removed: [] });
  });
  await expect(tree.locator('[data-project-path="/work/z-web"] svg path').first()).toHaveAttribute(
    "d",
    (await shape("project-react"))!,
  );
});
