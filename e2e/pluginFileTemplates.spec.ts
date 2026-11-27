import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("plugin templates keep exact names and collect variables before creation", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    window.__ipc.handlers.fs_create_file = () => null;
    window.__ipc.handlers.fs_probe = () => ({ size: 0, binary: false, tooLarge: false });
    window.__ipc.handlers.project_roots = () => ({ detected: [] });
    const module = "/src/workbench/contributions.ts";
    const { addContributedFileTemplate } = await import(/* @vite-ignore */ module);
    for (const [id, fileName, variables] of [
      ["ignore", ".dockerignore", []],
      [
        "attributes",
        ".gitattributes",
        [
          { name: "FILTER", prompt: "Attribute filter" },
          { name: "PATTERN", prompt: "File pattern" },
        ],
      ],
    ]) {
      addContributedFileTemplate({
        id: `plugin.fixture.${id}`,
        name: String(fileName),
        icon: "file",
        extension: "txt",
        nameStyle: "asis",
        fileName,
        variables,
        reformat: false,
        kinds: [{ id: "file", label: String(fileName), body: "" }],
      });
    }
    const storeModule = "/src/features/templates/files/store.ts";
    const { fileTemplates, saveFileTemplate } = await import(/* @vite-ignore */ storeModule);
    // Older saved customizations contain the body but none of the new declaration fields.
    const legacy = { ...fileTemplates().find((t: { id: string }) => t.id === "plugin.fixture.attributes") };
    delete legacy.fileName;
    delete legacy.variables;
    delete legacy.inferPackage;
    saveFileTemplate(legacy);
    const actions = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actions);
    await executeAction("templates.new.plugin.fixture.ignore", { directory: "/dev/acme-api" });
  });
  await expect.poll(async () => (await ipcCalls(page, "fs_create_file")).length).toBe(1);
  expect((await ipcCalls(page, "fs_create_file"))[0]).toEqual({ path: "/dev/acme-api/.dockerignore" });
  await expect(page.getByRole("dialog", { name: "New .dockerignore" })).not.toBeVisible();
  const open = async () =>
    page.evaluate(async () => {
      const module = "/src/platform/actions.ts";
      const { executeAction } = await import(/* @vite-ignore */ module);
      await executeAction("templates.new.plugin.fixture.attributes", { directory: "/dev/acme-api" });
    });
  await open();
  const dialog = page.getByRole("dialog", { name: "New .gitattributes" });
  await expect(dialog.getByRole("textbox")).toHaveCount(2);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog.getByText("Enter a value for each variable")).toBeVisible();
  await dialog.getByLabel("Attribute filter").fill("lfs");
  await dialog.getByLabel("File pattern").fill("*.bin");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await ipcCalls(page, "fs_create_file")).toHaveLength(1);
  await open();
  await dialog.getByLabel("Attribute filter").fill("lfs");
  await dialog.getByLabel("File pattern").fill("*.bin");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(async () => (await ipcCalls(page, "fs_create_file")).length).toBe(2);
  expect((await ipcCalls(page, "fs_create_file"))[1]).toEqual({ path: "/dev/acme-api/.gitattributes" });
});
