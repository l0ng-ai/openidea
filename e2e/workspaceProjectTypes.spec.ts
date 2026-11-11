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

test("keeps surviving workspace icons and type order during removal", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const module = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ module);
    const current = useProject.getState().project;
    const projects = ["/work/a-go", "/work/b-web", "/work/z-rust"];
    const project = {
      ...current,
      root: "/workspace",
      name: "Workspace",
      workspace: { version: 1, name: "Workspace", projects },
    };
    const markers: Record<string, string> = {
      "/work/a-go": "go.mod",
      "/work/b-web": "package.json",
      "/work/z-rust": "Cargo.toml",
    };
    const rescan = new Promise<void>((resolve) => {
      window.__ipc.handlers.finish_workspace_rescan = () => resolve();
    });
    let removed = false;
    window.__ipc.handlers.fs_read_dir = async ({ path }) => {
      if (removed) await rescan;
      const name = markers[String(path)];
      return name
        ? [{ path: `${path}/${name}`, name, kind: "file", size: 0, mtimeMs: 0, ignored: false, excluded: false }]
        : [];
    };
    window.__ipc.handlers.project_roots = () => ({ folders: [] });
    window.__ipc.handlers.workspace_update = ({ projects }) => {
      removed = true;
      return { ...project, workspace: { ...project.workspace, projects } };
    };
    useProject.setState({ project });
  });

  const tree = page.getByRole("tree", { name: "Project" });
  const rust = tree.locator('[data-project-path="/work/z-rust"]');
  const go = tree.locator('[data-project-path="/work/a-go"]');
  const web = tree.locator('[data-project-path="/work/b-web"]');
  const icons = () =>
    Promise.all(
      [rust, go].map((row) =>
        row.locator("svg path").evaluateAll((paths) => paths.map((path) => path.getAttribute("d"))),
      ),
    );
  const panel = page.getByRole("region", { name: "Project", exact: true });
  await panel.getByRole("button", { name: "Collapse All", exact: true }).click();
  await panel.getByRole("button", { name: "Options", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Sort by Type", exact: true }).click();
  const rows = tree.locator('[data-project-path^="/work/"]');
  await expect(rows).toHaveText(["z-rust/work/z-rust", "a-go/work/a-go", "b-web/work/b-web"]);
  const before = await icons();

  await web.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove from Workspace", exact: true }).click();
  await expect(web).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("workspace-removal.png"), animations: "disabled" });
  expect(await icons()).toEqual(before);
  await expect(rows).toHaveText(["z-rust/work/z-rust", "a-go/work/a-go"]);

  await page.evaluate(() => window.__ipc.handlers.finish_workspace_rescan!({}));
});
