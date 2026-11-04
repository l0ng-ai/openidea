/** Deployment diff over an in-memory server: no SSH or filesystem writes. */
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

test("native deployment entry fills its own window and exposes minimize and maximize controls", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/deployment-window-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    }),
  );
  await page.goto("/deployment-window-test");
  await page.evaluate(async () => {
    const refreshModule = "/@react-refresh";
    const { default: refresh } = await import(/* @vite-ignore */ refreshModule);
    refresh.injectIntoGlobalHook(window);
    Object.assign(window, {
      $RefreshReg$: () => {},
      $RefreshSig$: () => (type: unknown) => type,
      __vite_plugin_react_preamble_installed__: true,
    });
    const mocksModule = "/node_modules/@tauri-apps/api/mocks.js";
    const { mockIPC, mockWindows } = await import(/* @vite-ignore */ mocksModule);
    const calls: string[] = [];
    (window as unknown as { deploymentCalls: string[] }).deploymentCalls = calls;
    const settings = {
      appearance: { theme: "dark", syncWithOs: false },
      deployment: { servers: [{ id: "staging", name: "Staging", kind: "local", rootPath: "/srv/app" }] },
    };
    let launch = true;
    const local = "<?php\nclass Perfil {\n    public $name = 'Local';\n}\n";
    const remote = "<?php\nclass Perfil {\n    public $name = 'Remote';\n}\n";
    mockWindows("deployment-main", "main");
    mockIPC(
      (command: string, args: Record<string, unknown>) => {
        calls.push(command);
        if (/deploy_(upload|download|sync|delete)|doc_save|fs_write/.test(command)) throw new Error("Unexpected write");
        if (command === "app_info")
          return { platform: "windows", version: "test", configDir: "/config", wayland: false };
        if (command === "settings_get") return settings;
        if (command === "project_current") return { root: "/second", name: "Second", settings };
        if (command === "window_take_launch") {
          if (!launch) return null;
          launch = false;
          return { deployment: { server: "staging", paths: ["/second/perfil.php"] } };
        }
        if (command === "deploy_coverage") return [{ server: "staging", paths: ["/second/perfil.php"], skipped: [] }];
        if (command === "deploy_compare")
          return [
            {
              path: "perfil.php",
              remotePath: "/srv/app/perfil.php",
              local: { size: local.length, mtime: 1700000100 },
              remote: { size: remote.length, mtime: 1700000000 },
              status: "localNewer",
            },
          ];
        if (command === "remote_open") return "/snapshot/perfil.php";
        if (command === "fs_probe") return { size: local.length, binary: false, tooLarge: false };
        if (command === "fs_read_text") return String(args.path).startsWith("/snapshot/") ? remote : local;
        if (command === "doc_open") throw new Error("Read-only test fixture");
        if (command === "languages") return [];
        if (command === "plugin:window|is_maximized" || command === "plugin:window|is_fullscreen") return false;
        return null;
      },
      { shouldMockEvents: true },
    );
    const entry = "/src/main.tsx";
    await import(/* @vite-ignore */ entry);
  });
  const comparison = page.getByRole("region", { name: "Diff Between 'local files' and 'files on Staging'" });
  await expect(comparison.getByRole("grid", { name: "Files to synchronize" })).toBeVisible();
  await expect(comparison.getByRole("region", { name: "perfil.php" }).getByRole("textbox")).toHaveCount(2);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("tree", { name: "Project" })).toHaveCount(0);
  const frame = await comparison.boundingBox();
  expect(frame!.y).toBe(0);
  expect(frame!.height).toBe(page.viewportSize()!.height);
  await expect(comparison.getByRole("button", { name: "Synchronize All", exact: true })).toBeInViewport();
  await expect(comparison.getByRole("button", { name: "Synchronize Selected", exact: true })).toBeVisible();
  await comparison.getByRole("button", { name: "Minimize", exact: true }).click();
  await comparison.getByRole("button", { name: "Maximize", exact: true }).click();
  // The caption buttons reach the window API asynchronously.
  const calls = () => page.evaluate(() => (window as unknown as { deploymentCalls: string[] }).deploymentCalls);
  await expect.poll(calls).toContain("plugin:window|minimize");
  await expect.poll(calls).toContain("plugin:window|toggle_maximize");
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("deployment-native-window.png") });
});

async function showComparison(page: Page) {
  await page.evaluate(async () => {
    const projectModule = "/src/platform/project.ts";
    const settingsModule = "/src/platform/remoteSettings.ts";
    const stateModule = "/src/features/deployment/store.ts";
    const routeModule = "/src/platform/tauriCore.ts";
    const backendModule = "/src/editor/core/backend.ts";
    const [{ useProject }, { DEFAULT_DEPLOYMENT_SERVER }, { useDeployment }, { setInvokeRoute }, { docBackend }] =
      await Promise.all([
        import(/* @vite-ignore */ projectModule),
        import(/* @vite-ignore */ settingsModule),
        import(/* @vite-ignore */ stateModule),
        import(/* @vite-ignore */ routeModule),
        import(/* @vite-ignore */ backendModule),
      ]);
    const local: Record<string, string> = {
      "app.js": "export const version = 'local';\n",
      "perfil.php":
        "<?php\nclass Perfil extends AppModel {\n    var $name = 'Perfil';\n    var $useTable = 'app_perfiles';\n    var $displayField = 'descripcion';\n\n    function getPerfilesValidos($model) {\n        return $this->find('list', [\n            'fields' => [$this->alias . '.id', $this->alias . '.descripcion'],\n            'order' => $this->alias . '.descripcion ASC',\n        ]);\n    }\n}\n",
      "hidden.php": "alpha",
      "same.js": "same",
    };
    const remote: Record<string, string> = {
      "app.js": "export const version = 'deployed';\n",
      "perfil.php":
        "<?php\nclass Perfil extends AppModel {\n    var $name = 'Perfil';\n    var $useTable = 'app_perfiles';\n}\n",
      "hidden.php": "bravo",
      "same.js": "same",
    };
    const root = useProject.getState().project.root;
    for (const [path, content] of Object.entries(local)) docBackend().files.set(`${root}/${path}`, content);
    const writes: string[] = [];
    (window as unknown as { deploymentWrites: string[] }).deploymentWrites = writes;
    const syncState = { enabled: false, transfers: [] as { path: string; action: string }[][] };
    (window as unknown as { deploymentSyncState: typeof syncState }).deploymentSyncState = syncState;
    const text = (path: string) => (path.startsWith("/snapshot/") ? remote : local)[path.split("/").at(-1)!] ?? "";
    setInvokeRoute((command: string, args: Record<string, unknown>) => {
      const path = String(args?.path ?? "");
      if (command === "remote_open") return Promise.resolve(`/snapshot/${path.split("/").at(-1)}`);
      if (command === "fs_probe") return Promise.resolve({ size: text(path).length, binary: false, tooLarge: false });
      if (command === "fs_read_text") return Promise.resolve(text(path));
      if (command === "fs_read_range") {
        const content = text(path);
        return Promise.resolve({
          total: content.length,
          offset: args.offset,
          data: btoa(content.slice(Number(args.offset), Number(args.offset) + Number(args.len))),
        });
      }
      if (command === "doc_open") return Promise.reject(new Error("No live document in this fixture"));
      if (command === "deploy_sync" && syncState.enabled) {
        const steps = args.steps as { path: string; action: string }[];
        syncState.transfers.push(steps.map((step) => ({ ...step })));
        writes.push(command);
        for (const step of steps) {
          if (step.action === "upload") remote[step.path] = local[step.path]!;
          else if (step.action === "download") local[step.path] = remote[step.path]!;
          else if (step.action === "deleteLocal") delete local[step.path];
          else if (step.action === "deleteRemote") delete remote[step.path];
        }
        return Promise.resolve({ files: steps.length, skipped: 0, errors: [] });
      }
      if (command === "deploy_compare") {
        const name = path.slice(root.length + 1);
        if (local[name] === undefined && remote[name] === undefined) return Promise.resolve([]);
        const identical = local[name] === remote[name];
        return Promise.resolve([
          {
            path: name,
            remotePath: `/srv/app/${name}`,
            local: local[name] === undefined ? null : { size: local[name]!.length, mtime: 1_700_000_100 },
            remote:
              remote[name] === undefined
                ? null
                : { size: remote[name]!.length, mtime: identical ? 1_700_000_100 : 1_700_000_000 },
            status:
              local[name] === undefined
                ? "remoteOnly"
                : remote[name] === undefined
                  ? "localOnly"
                  : identical
                    ? "same"
                    : "localNewer",
          },
        ]);
      }
      if (/deploy_(upload|download|sync|delete)|doc_save|fs_write/.test(command)) {
        writes.push(command);
        return Promise.reject(new Error("Unexpected write"));
      }
      return null;
    });
    const entries = Object.keys(local).map((path) => ({
      path,
      remotePath: `/srv/app/${path}`,
      local: { size: local[path]!.length, mtime: 1_700_000_100 },
      remote: { size: remote[path]!.length, mtime: 1_700_000_000 },
      status: path === "hidden.php" || path === "same.js" ? "same" : "localNewer",
    }));
    useProject.setState({
      settings: {
        ...useProject.getState().settings,
        appearance: { ...useProject.getState().settings?.appearance, theme: "dark", syncWithOs: false },
        deployment: {
          servers: [
            { ...DEFAULT_DEPLOYMENT_SERVER, id: "staging", kind: "local", name: "Staging", rootPath: "/srv/app" },
          ],
        },
      },
    });
    useDeployment.setState({
      sync: {
        server: "staging",
        serverName: "Staging",
        paths: [useProject.getState().project.root],
        entries,
        skipped: [],
        request: null,
        error: null,
        choices: Object.fromEntries(entries.map((entry) => [entry.path, entry.status === "same" ? "skip" : "upload"])),
        hideSame: true,
        running: false,
      },
    });
  });
}

test("deployment shows mirrored lists and a selectable side-by-side content diff", async ({
  workbench: page,
}, info) => {
  await showComparison(page);
  const dialog = page.getByRole("dialog", { name: "Diff Between 'local files' and 'files on Staging'" });
  await expect(dialog).toBeVisible();
  const grid = dialog.getByRole("grid", { name: "Files to synchronize" });
  await grid.getByRole("combobox", { name: "Action perfil.php" }).locator("..", {}).locator("..").click();
  const preview = dialog.locator('[aria-label="Deployment content comparison"]');
  await expect(preview.locator(".cm-editor")).toHaveCount(2);
  await expect(preview.locator(".cm-editor").first()).toContainText("getPerfilesValidos");
  await expect(preview.locator(".cm-editor").last()).not.toContainText("getPerfilesValidos");
  await expect(preview.locator(".cm-editor").last().locator(".cm-content")).toHaveAttribute("contenteditable", "false");
  await expect(dialog.getByRole("toolbar", { name: "Diff" })).toBeVisible();
  await expect(dialog.getByRole("separator", { name: "Resize file list and diff preview" })).toBeVisible();
  await dialog.screenshot({ path: info.outputPath("deployment-comparison.png"), animations: "disabled" });
  await page.getByLabel("Action perfil.php", { exact: true }).selectOption("skip");
  await grid.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { deploymentWrites: string[] }).deploymentWrites)).toEqual([]);
});

test("Synchronize Selected and Enter transfer one file at a time while the comparison stays open", async ({
  workbench: page,
}) => {
  await showComparison(page);
  await page.evaluate(() => {
    (window as unknown as { deploymentSyncState: { enabled: boolean } }).deploymentSyncState.enabled = true;
  });
  const dialog = page.getByRole("dialog", { name: "Diff Between 'local files' and 'files on Staging'" });
  const grid = dialog.getByRole("grid", { name: "Files to synchronize" });
  await grid.getByRole("combobox", { name: "Action perfil.php" }).locator("..").locator("..").click();
  await dialog.getByRole("button", { name: "Synchronize Selected", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(grid.getByRole("combobox", { name: "Action perfil.php" })).toHaveCount(0);
  await expect(grid.getByRole("combobox", { name: "Action app.js" })).toHaveValue("upload");
  await expect(dialog.locator('[aria-label="Deployment content comparison"] .cm-editor').last()).toContainText(
    "deployed",
  );
  await grid.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "Synchronize All", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Synchronize Selected", exact: true })).toBeDisabled();
  await expect(dialog).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { deploymentSyncState: { transfers: unknown[] } }).deploymentSyncState.transfers,
    ),
  ).toEqual([[{ path: "perfil.php", action: "upload" }], [{ path: "app.js", action: "upload" }]]);
});

test("binary content finds changes hidden by metadata and file filters keep the preview in sync", async ({
  workbench: page,
}) => {
  await showComparison(page);
  await page.getByLabel("Compare by", { exact: true }).selectOption("content");
  await expect(page.getByLabel("Action hidden.php", { exact: true })).toHaveValue("upload");
  await expect(page.getByLabel("Action same.js", { exact: true })).toHaveCount(0);
  await page.getByLabel("Filter by name", { exact: true }).fill("hidden.php");
  const preview = page.locator('[aria-label="Deployment content comparison"]');
  await expect(preview.locator(".cm-editor").first()).toContainText("alpha");
  await expect(preview.locator(".cm-editor").last()).toContainText("bravo");
  await page.getByLabel("Action hidden.php", { exact: true }).selectOption("skip");
  expect(await page.evaluate(() => (window as unknown as { deploymentWrites: string[] }).deploymentWrites)).toEqual([]);
});
