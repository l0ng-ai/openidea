import { expect, stubDesktop, test } from "./fixtures";

test.use({ video: "on" });

test("sorts collapsed workspace roots by project type, shows their icons and refreshes changed markers", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const markers: Record<string, string[]> = {
      "z-web": ["package.json"],
      go10: ["go.mod"],
      Go2: ["go.mod"],
      mobile: ["pubspec.yaml", ".metadata"],
      dart: ["pubspec.yaml"],
      library: ["build.gradle.kts"],
      server: ["pom.xml"],
      py: ["pyproject.toml"],
      rust: ["Cargo.toml"],
      site: ["package.json", "vite.config.ts"],
      notes: ["README.md"],
    };
    const listing = (path: string) =>
      (markers[path.slice("/work/".length)] ?? []).map((name) => ({
        path: `${path}/${name}`,
        name,
        kind: "file",
        size: 10,
        mtimeMs: 0,
        ignored: false,
        excluded: false,
        hidden: name.startsWith("."),
      }));
    window.__ipc.handlers.fs_read_dir = ({ path }) => listing(String(path));
    const module = "/src/features/project-tree/store.ts";
    const { initProjectTree, useProjectTree } = await import(/* @vite-ignore */ module);
    initProjectTree(
      "/workspace",
      "Workspace",
      Object.keys(markers).map((name) => `/work/${name}`),
    );
    useProjectTree.setState({ expanded: new Set() });
  });
  const tree = page.getByRole("tree", { name: "Project" });
  await page
    .getByRole("region", { name: "Project", exact: true })
    .getByRole("button", { name: "Options", exact: true })
    .click();
  await page.getByRole("menuitemcheckbox", { name: "Sort by Type", exact: true }).click();
  await expect(tree.locator("[data-project-path]")).toHaveText([
    "rust/work/rust",
    "dart/work/dart",
    "mobile/work/mobile",
    "Go2/work/Go2",
    "go10/work/go10",
    "library/work/library",
    "server/work/server",
    "z-web/work/z-web",
    "py/work/py",
    "site/work/site",
    "notes/work/notes",
  ]);
  const shape = (name: string) =>
    page.evaluate(async (icon) => {
      const module = "/src/ui/icons.tsx";
      const { iconMarkup } = await import(/* @vite-ignore */ module);
      return [...new DOMParser().parseFromString(iconMarkup(icon)!, "image/svg+xml").querySelectorAll("path")].map(
        (path) => path.getAttribute("d"),
      );
    }, name);
  for (const [name, icon] of [
    ["z-web", "file-npm"],
    ["Go2", "file-go"],
    ["go10", "file-go"],
    ["mobile", "project-flutter"],
    ["dart", "file-dart"],
    ["library", "gradle-project"],
    ["server", "maven-project"],
    ["rust", "file-cargo"],
    ["py", "file-python"],
    ["site", "project-vite"],
    ["notes", "module"],
  ]) {
    const row = tree.locator(`[data-project-path="/work/${name}"]`);
    await expect
      .poll(() => row.locator("svg path").evaluateAll((paths) => paths.map((path) => path.getAttribute("d"))))
      .toEqual(await shape(icon!));
    await expect(row.locator("[data-project-path]")).toHaveCount(0);
  }
  await tree.locator('[data-project-path="/work/z-web"]').click();
  await page.evaluate(() => {
    const original = window.__ipc.handlers.fs_read_dir!;
    window.__ipc.handlers.fs_read_dir = (args) =>
      args.path === "/work/z-web"
        ? [
            {
              path: "/work/z-web/go.mod",
              name: "go.mod",
              kind: "file",
              size: 10,
              mtimeMs: 0,
              ignored: false,
              excluded: false,
              hidden: false,
            },
          ]
        : original(args);
    window.__ipc.emit({
      type: "fsChanged",
      created: ["/work/z-web/go.mod"],
      modified: [],
      removed: ["/work/z-web/package.json"],
    });
  });
  await expect
    .poll(() =>
      tree
        .locator('[data-project-path="/work/z-web"] svg path')
        .evaluateAll((paths) => paths.map((path) => path.getAttribute("d"))),
    )
    .toEqual(await shape("file-go"));
  await expect(tree.locator("[data-project-path]")).toHaveText([
    "rust/work/rust",
    "dart/work/dart",
    "mobile/work/mobile",
    "Go2/work/Go2",
    "go10/work/go10",
    "z-web/work/z-web",
    "library/work/library",
    "server/work/server",
    "py/work/py",
    "site/work/site",
    "notes/work/notes",
  ]);
  await expect(tree.getByRole("treeitem", { selected: true })).toContainText("z-web");
});
