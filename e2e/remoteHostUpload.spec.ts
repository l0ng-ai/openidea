/** Direct uploads use fictional SFTP listings and the production Project / Remote Host trees. */
import { test, expect, ipcCalls, stubDesktop } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

async function showRemoteHost(page: Page) {
  await page.evaluate(async () => {
    const projectModule = "/src/platform/project.ts";
    const settingsModule = "/src/platform/remoteSettings.ts";
    const routeModule = "/src/platform/tauriCore.ts";
    const actionsModule = "/src/platform/actions.ts";
    const [{ useProject }, { DEFAULT_DEPLOYMENT_SERVER }, { setInvokeRoute }, { executeAction }] = await Promise.all([
      import(/* @vite-ignore */ projectModule),
      import(/* @vite-ignore */ settingsModule),
      import(/* @vite-ignore */ routeModule),
      import(/* @vite-ignore */ actionsModule),
    ]);
    const entry = (path: string, isDir: boolean) => ({
      path,
      name: path.split("/").at(-1)!,
      isDir,
      isSymlink: false,
      size: 0,
      mtime: null,
      permissions: "",
    });
    const state = {
      uploads: [] as { paths: string[]; target: string; replace: boolean }[],
      listings: {
        "/srv/demo": [entry("/srv/demo/assets", true), entry("/srv/demo/index.html", false)],
        "/srv/demo/assets": [entry("/srv/demo/assets/keep.txt", false)],
      } as Record<string, ReturnType<typeof entry>[]>,
    };
    (window as unknown as { uploadDemo: typeof state }).uploadDemo = state;
    setInvokeRoute((command: string, args?: Record<string, unknown>) => {
      if (command === "deploy_server_root") return Promise.resolve({ root: "/srv/demo", mappings: [] });
      if (command === "remote_list") return Promise.resolve(state.listings[String(args?.path)] ?? []);
      if (command === "remote_upload_into") {
        const upload = args as unknown as { paths: string[]; target: string; replace: boolean };
        state.uploads.push({ paths: [...upload.paths], target: upload.target, replace: upload.replace });
        for (const source of upload.paths) {
          const name = source
            .replace(/[\\/]+$/, "")
            .split(/[\\/]/)
            .at(-1)!;
          const entries = (state.listings[upload.target] ??= []);
          if (!entries.some((e) => e.name === name)) entries.push(entry(`${upload.target}/${name}`, false));
        }
        return Promise.resolve({ files: upload.paths.length, skipped: 0, errors: [] });
      }
      return null;
    });
    useProject.setState({
      settings: {
        ...useProject.getState().settings,
        deployment: {
          servers: [
            {
              ...DEFAULT_DEPLOYMENT_SERVER,
              id: "demo-sftp",
              name: "Demo SFTP",
              sshConfig: "demo",
              rootPath: "/srv/demo",
              mappings: [],
            },
          ],
          defaultServer: "demo-sftp",
        },
      },
    });
    await executeAction("deployment.browseRemoteHost");
  });
  await expect(page.getByRole("tree", { name: "Remote files" })).toBeVisible();
}

async function drag(page: Page, source: Locator, target: Locator) {
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + Math.min(80, from.width / 2), from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
  await expect(page.getByRole("status").filter({ hasText: "Upload to /srv/demo/assets" })).toBeVisible();
  await page.mouse.up();
}

const uploads = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { uploadDemo: { uploads: { paths: string[]; target: string; replace: boolean }[] } })
        .uploadDemo.uploads,
  );

test("Project drops upload without mappings; repeated names require confirmation", async ({
  workbench: page,
}, info) => {
  await showRemoteHost(page);
  const project = page.getByRole("tree", { name: "Project", exact: true });
  const remote = page.getByRole("tree", { name: "Remote files" });
  const source = project.getByRole("treeitem", { name: "README.md", exact: true });
  const folder = remote.getByRole("treeitem", { name: "assets", exact: true });
  await folder.dblclick();
  await expect(remote.getByRole("treeitem", { name: "keep.txt", exact: true })).toBeVisible();
  await drag(page, source, folder);
  await expect(remote.getByRole("treeitem", { name: "README.md", exact: true })).toBeVisible();
  expect(await uploads(page)).toEqual([
    { paths: ["/dev/acme-api/README.md"], target: "/srv/demo/assets", replace: false },
  ]);
  await drag(page, source, folder);
  const dialog = page.getByRole("dialog", { name: "Replace Existing Files?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await uploads(page)).toHaveLength(1);
  await drag(page, source, folder);
  await dialog.getByRole("button", { name: "Replace", exact: true }).click();
  await expect.poll(async () => (await uploads(page)).at(-1)?.replace).toBe(true);
  await expect(remote.getByRole("treeitem", { name: "keep.txt", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("remote-host-upload.png"), animations: "disabled" });
});

test("desktop drops use file parents or blank root space and avoid opening editor tabs", async ({
  workbench: page,
}) => {
  await showRemoteHost(page);
  const remote = page.getByRole("tree", { name: "Remote files" });
  const target = remote.getByRole("treeitem", { name: "index.html", exact: true });
  const point = await target.boundingBox();
  await page.evaluate(
    async ({ x, y }) => {
      const module = "/src/workbench/fileDrop.ts";
      const { handleFileDrop } = await import(/* @vite-ignore */ module);
      await handleFileDrop(["C:/Demo Downloads/banner.svg", "C:/Demo Downloads/photos"], x, y);
    },
    { x: point!.x + 80, y: point!.y + point!.height / 2 },
  );
  await expect(remote.getByRole("treeitem", { name: "banner.svg", exact: true })).toBeVisible();
  const treeBox = (await remote.boundingBox())!;
  await page.evaluate(
    async ({ x, y }) => {
      const module = "/src/workbench/fileDrop.ts";
      const { handleFileDrop } = await import(/* @vite-ignore */ module);
      await handleFileDrop(["C:/Demo Downloads/notes.txt"], x, y);
    },
    { x: treeBox.x + 70, y: treeBox.y + 180 },
  );
  await expect.poll(async () => (await uploads(page)).length).toBe(2);
  expect(await uploads(page)).toEqual([
    { paths: ["C:/Demo Downloads/banner.svg", "C:/Demo Downloads/photos"], target: "/srv/demo", replace: false },
    { paths: ["C:/Demo Downloads/notes.txt"], target: "/srv/demo", replace: false },
  ]);
  await expect(page.getByRole("tab", { name: "banner.svg", exact: true })).toHaveCount(0);
});

test("Upload Folder… opens a directory picker and cancellation leaves the server untouched", async ({
  workbench: page,
}) => {
  await showRemoteHost(page);
  await stubDesktop(page);
  await page.evaluate(() => {
    let picked = false;
    window.__ipc.handlers["plugin:dialog|open"] = () => {
      if (picked) return null;
      picked = true;
      return "C:/Demo Downloads/photos";
    };
  });
  const remote = page.getByRole("tree", { name: "Remote files" });
  const folder = remote.getByRole("treeitem", { name: "assets", exact: true });
  await folder.dblclick();
  await folder.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Upload Files…", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Upload Folder…", exact: true }).click();
  await expect(remote.getByRole("treeitem", { name: "photos", exact: true })).toBeVisible();
  expect(await ipcCalls(page, "plugin:dialog|open")).toEqual([
    expect.objectContaining({ options: expect.objectContaining({ directory: true, multiple: false }) }),
  ]);
  expect(await uploads(page)).toEqual([
    { paths: ["C:/Demo Downloads/photos"], target: "/srv/demo/assets", replace: false },
  ]);
  await folder.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Upload Folder…", exact: true }).click();
  await expect.poll(async () => (await ipcCalls(page, "plugin:dialog|open")).length).toBe(2);
  expect(await uploads(page)).toHaveLength(1);
});
