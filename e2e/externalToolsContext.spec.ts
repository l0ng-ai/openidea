import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

// #5402: an External Tool run from Find Action resolves $FilePath$ against the focused component,
// the Project view's selected file while the tree has focus, else the editor's file.
test("External Tools take $FilePath$ from the Project view selection, else the editor", async ({ workbench: page }) => {
  await page.getByRole("treeitem", { name: "README.md", exact: true }).dblclick();
  const editor = page.locator(".cm-content");
  await expect(editor).toBeFocused();
  await stubDesktop(page);
  await page.evaluate(async () => {
    const projectPath = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ projectPath);
    const tool = { id: "echo", name: "Echo File Path", program: "echo", arguments: "$FilePath$ $FileName$" };
    useProject.setState({
      settings: {
        editor: { tabs: { previewTab: false } },
        externalTools: [{ ...tool, openConsole: false, synchronizeAfter: false }],
      },
    });
    let id = 0;
    window.__ipc.handlers.run_start = ({ config }) => {
      id++;
      // Exits at once, so the next run of the same tool doesn't ask to stop this one.
      window.__ipc.emit({ type: "runExited", run: id, code: 0 });
      return {
        id,
        configId: (config as { id: string }).id,
        name: (config as { name: string }).name,
        pid: 4242,
        running: true,
        pty: false,
      };
    };
  });

  const runTool = async () => {
    await page.keyboard.press("Meta+Shift+A");
    const search = page.getByRole("dialog", { name: "Search Everywhere", exact: true });
    await search.getByRole("combobox").fill("Echo File Path");
    await expect(search.getByRole("option", { name: /Echo File Path/ })).toBeVisible();
    await search.getByRole("combobox").press("Enter");
    await expect(search).toBeHidden();
  };
  const startedArgs = async () =>
    (await ipcCalls(page, "run_start")).map((c) => (c as { config: { args: string[] } }).config.args);

  await page.getByRole("treeitem", { name: "build.gradle.kts", exact: true }).click();
  await expect(page.getByRole("tab", { name: "README.md", exact: true })).toHaveAttribute("aria-selected", "true");
  await runTool();
  await expect.poll(startedArgs).toEqual([["/dev/acme-api/build.gradle.kts", "build.gradle.kts"]]);

  await editor.click();
  await expect(editor).toBeFocused();
  await runTool();
  await expect.poll(startedArgs).toEqual([
    ["/dev/acme-api/build.gradle.kts", "build.gradle.kts"],
    ["/dev/acme-api/README.md", "README.md"],
  ]);
});
