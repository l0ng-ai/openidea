import { expect, stubDesktop, test } from "./fixtures";

test("System Settings groups file controls before caches and keeps the idle timeout unit beside its field", async ({
  workbench: page,
}) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const system = dialog.getByRole("treeitem", { name: "System Settings", exact: true });
  const search = dialog.getByRole("textbox", { name: "Search settings" });
  await search.fill("Autosave");
  await expect(system).toBeVisible();
  await search.clear();
  await system.click();
  const exit = dialog.getByRole("checkbox", { name: "Confirm before exiting the IDE" });
  const reopen = dialog.getByRole("checkbox", { name: "Reopen projects on startup" });
  const project = dialog.getByRole("region", { name: "Project", exact: true });
  const directory = project.getByRole("textbox", { name: /^Default directory/ });
  const browse = project.getByRole("button", { name: "Browse", exact: true });
  const idle = dialog.getByRole("checkbox", { name: "Save files if the IDE is idle for" });
  const timeout = dialog.getByRole("textbox", { name: "Idle seconds" });
  const unit = dialog.getByText("seconds", { exact: true });
  const caches = dialog.getByRole("region", { name: "Caches", exact: true });
  for (const width of [1120, 580]) {
    await page.setViewportSize({ width, height: 760 });
    await expect(async () => {
      const [exitBox, projectBox, idleBox, timeoutBox, unitBox, cacheBox] = await Promise.all(
        [exit, reopen, idle, timeout, unit, caches].map((item) => item.boundingBox()),
      );
      expect(exitBox!.y).toBeLessThan(projectBox!.y);
      expect(projectBox!.y).toBeLessThan(idleBox!.y);
      expect(idleBox!.y).toBeLessThan(cacheBox!.y);
      expect(unitBox!.x).toBeGreaterThanOrEqual(timeoutBox!.x + timeoutBox!.width);
      expect(unitBox!.y).toBeGreaterThan(timeoutBox!.y);
      expect(unitBox!.y + unitBox!.height).toBeLessThanOrEqual(timeoutBox!.y + timeoutBox!.height + 1);
      const [directoryBox, browseBox] = await Promise.all([directory.boundingBox(), browse.boundingBox()]);
      expect(browseBox!.x).toBeGreaterThanOrEqual(directoryBox!.x + directoryBox!.width);
      expect(browseBox!.y).toBeGreaterThanOrEqual(directoryBox!.y);
      expect(browseBox!.y + browseBox!.height).toBeLessThanOrEqual(directoryBox!.y + directoryBox!.height + 1);
    }).toPass({ timeout: 3000 });
  }

  const files = dialog.getByRole("region", { name: "Files", exact: true });
  const sync = files
    .getByRole("group", { name: "Synchronization", exact: true })
    .getByRole("checkbox", { name: "Synchronize external changes when switching to the IDE window" });
  await idle.check();
  await timeout.fill("22");
  await sync.uncheck();
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await page.keyboard.press("Meta+,");
  await system.click();
  await expect(idle).toBeChecked();
  await expect(timeout).toHaveValue("22");
  await expect(sync).not.toBeChecked();
});

test("Add Python Interpreter keeps environment labels and fields inside their rows", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("textbox", { name: "Search settings" }).fill("Python Interpreter");
  await settings
    .getByRole("tree", { name: "Settings pages" })
    .getByRole("treeitem", { name: "Dependencies", exact: true })
    .click();
  await settings.getByRole("button", { name: "Add Interpreter…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add Python Interpreter", exact: true });
  await expect(dialog).toBeVisible();

  for (const width of [1000, 800, 520]) {
    await page.setViewportSize({ width, height: 760 });
    await expect(async () => {
      const labelsFit = await dialog.getByRole("list", { name: "Interpreter type" }).evaluate((list) =>
        [...list.querySelectorAll("button")].every((button) => {
          const box = button.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(button);
          return [...range.getClientRects()].every(
            (r) => r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.right <= box.right + 1,
          );
        }),
      );
      expect(labelsFit).toBe(true);
    }).toPass({ timeout: 3000 });

    const location = dialog.getByRole("textbox", { name: "Location:", exact: true });
    const fieldSpacing = await location.evaluate((input) => ({
      rowHeight: input.parentElement!.getBoundingClientRect().height,
      fieldHeight: input.getBoundingClientRect().height,
    }));
    expect(fieldSpacing.rowHeight).toBeLessThanOrEqual(fieldSpacing.fieldHeight + 1);
    const base = await dialog.getByRole("button", { name: "Base interpreter", exact: true }).boundingBox();
    const loc = await location.boundingBox();
    expect(base!.y - loc!.y - loc!.height).toBeLessThan(50);
  }
});

test("Project Structure keeps edits across repeated shortcuts and applies them", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+;");
  const dialog = page.getByRole("dialog", { name: "Project Structure", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Compiler output", { exact: true }).fill("out/classes");
  await page.keyboard.press("Meta+;");
  await expect(dialog.getByLabel("Compiler output", { exact: true })).toHaveValue("out/classes");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.keyboard.press("Meta+;");
  await expect(dialog.getByLabel("Compiler output", { exact: true })).toHaveValue("out/classes");
  await dialog.getByRole("button", { name: "Modules", exact: true }).click();
  await dialog.getByRole("button", { name: "Dependencies", exact: true }).click();
  await expect(dialog.getByRole("group", { name: "The project depends on these projects" })).toBeVisible();
  await dialog.getByRole("button", { name: "Artifacts", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "JAR", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("⌘, opens Settings with the page tree; Escape closes", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  const item = (name: string) => dialog.getByRole("treeitem", { name, exact: true });
  for (const name of ["Appearance & Behavior", "Keymap", "Editor"]) {
    await expect(item(name)).toBeVisible();
  }
  // The tree is virtualized: collapse Editor (expanded by default) so the later groups render.
  await item("Editor").click();
  await page.keyboard.press("ArrowLeft");
  await expect(item("Editor")).not.toHaveAttribute("aria-expanded", "true");
  for (const name of ["Plugins", "Version Control"]) {
    await expect(item(name)).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("Directory Mappings keeps the controls and headers visible while scrolling repositories", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 760, height: 550 });
  await stubDesktop(page);
  await page.evaluate(() => {
    const parent = "/dev/acme-api/integrations/finance-and-order-reconciliation";
    window.__ipc.handlers.vcs_detected_roots = () =>
      Array.from({ length: 32 }, (_, i) =>
        `${parent}/ledger-adapter-${String(i + 1).padStart(2, "0")}`.replaceAll("/", "\\"),
      );
    window.__ipc.handlers["plugin:dialog|open"] = () => `${parent}/billing-audit-adapter`;
  });
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("textbox", { name: "Search settings" }).fill("Directory Mappings");
  await settings.getByRole("treeitem", { name: "Directory Mappings", exact: true }).click();
  const table = settings.getByRole("table", { name: "Directory mappings", exact: true });
  await expect(table.getByRole("row")).toHaveCount(33);
  const header = table.getByRole("columnheader", { name: "Directory", exact: true });
  const vcsHeader = table.getByRole("columnheader", { name: "VCS", exact: true });
  const toolbar = settings.getByRole("toolbar", { name: "Directory mappings actions" });
  const directoryBox = (await header.boundingBox())!;
  expect(directoryBox.width).toBeGreaterThan(2 * (await vcsHeader.boundingBox())!.width);

  const viewport = table.locator("xpath=..");
  await expect.poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
  expect(await viewport.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await viewport.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(toolbar.getByRole("button", { name: "Add", exact: true })).toBeInViewport({ ratio: 1 });
  expect(Math.abs((await header.boundingBox())!.y - directoryBox.y)).toBeLessThan(1);

  const repo = table.getByRole("row").filter({ hasText: "ledger-adapter-32" });
  const name = repo.getByText("ledger-adapter-32", { exact: true });
  await expect(name).toBeInViewport({ ratio: 1 });
  expect(await name.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  const vcs = repo.getByRole("button", {
    name: "VCS of integrations/finance-and-order-reconciliation/ledger-adapter-32",
    exact: true,
  });
  await name.click();
  const remove = toolbar.getByRole("button", { name: "Remove", exact: true });
  await expect(remove).toBeEnabled();
  await remove.click();
  const unregistered = table.getByRole("rowgroup", { name: "Unregistered roots" });
  await expect(unregistered.getByRole("row").last()).toContainText("ledger-adapter-32");
  await expect(repo).toHaveAttribute("aria-selected", "true");
  await expect(repo.getByRole("cell", { name: "Git", exact: true })).toBeVisible();
  await expect(remove).toBeDisabled();

  const add = toolbar.getByRole("button", { name: "Add", exact: true });
  await add.click();
  await expect(vcs).toHaveText("Git");
  await expect(unregistered).toHaveCount(0);
  await expect(table.getByText("billing-audit-adapter", { exact: true })).toHaveCount(0);

  const ledger = (n: number) => table.getByText(`ledger-adapter-${n}`, { exact: true });
  const selectedNames = () => table.locator("tr[aria-selected=true] td:first-child").allTextContents();
  await ledger(29).click();
  await ledger(31).click({ modifiers: ["Meta"] });
  expect(await selectedNames()).toEqual([
    "integrations/finance-and-order-reconciliation/ledger-adapter-29",
    "integrations/finance-and-order-reconciliation/ledger-adapter-31",
  ]);
  await ledger(29).click();
  await ledger(31).click({ modifiers: ["Shift"] });
  await expect(table.locator("tr[aria-selected=true]")).toHaveCount(3);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await remove.click();
  await expect(unregistered.getByRole("row")).toHaveCount(4);
  await expect(unregistered.locator("tr[aria-selected=true]")).toHaveCount(3);
  await expect(unregistered.getByText("ledger-adapter-29", { exact: true })).toBeVisible();
  await expect(unregistered.getByText("ledger-adapter-30", { exact: true })).toBeVisible();
  await expect(unregistered.getByText("ledger-adapter-31", { exact: true })).toBeVisible();
  await ledger(32).click({ modifiers: ["Meta"] });
  await expect(remove).toBeDisabled();
  await expect(add).toBeDisabled();
  await ledger(32).click({ modifiers: ["Meta"] });
  await add.click();
  await expect(unregistered).toHaveCount(0);
  await expect(table.locator("tr[aria-selected=true]")).toHaveCount(3);

  await add.click();
  const added = table.getByRole("row").filter({ hasText: "billing-audit-adapter" });
  await expect(added.getByText("billing-audit-adapter", { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(added).toHaveAttribute("aria-selected", "true");
  await remove.click();
  await expect(added).toHaveCount(0);

  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(settings).toBeHidden();
});

test("editor appearance groups related controls and keeps whitespace options editable", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("textbox", { name: "Search settings" }).fill("Show whitespaces");
  await settings.getByRole("treeitem", { name: "Appearance", exact: true }).click();
  const section = (name: string) => settings.getByRole("region", { name, exact: true });

  await expect(section("Caret").getByRole("checkbox", { name: "Use block caret" })).toBeVisible();
  await expect(section("Code Structure").getByRole("checkbox", { name: "Show line numbers" })).toBeVisible();
  await expect(section("Code Assistance").getByRole("checkbox", { name: "Show intention bulb" })).toBeVisible();
  const presentation = section("Presentation");
  await expect(presentation.getByRole("checkbox", { name: "Render documentation comments" })).toBeVisible();
  await expect(presentation.getByRole("textbox", { name: "Distraction free mode text width:" })).toBeVisible();
  const whitespace = presentation.getByRole("checkbox", { name: "Show whitespaces" });
  const leading = presentation.getByRole("checkbox", { name: "Leading", exact: true });
  if (await whitespace.isChecked()) await whitespace.uncheck();
  await expect(leading).toBeDisabled();
  await whitespace.check();
  await expect(leading).toBeEnabled();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(settings).toBeHidden();
});

test("Language Servers page installs a tool with progress (in-memory installer)", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  // The page tree is virtualized; search brings the page into view.
  await dialog.getByRole("textbox", { name: "Search settings" }).fill("Language Servers");
  await dialog.getByRole("treeitem", { name: "Language Servers", exact: true }).click();
  const languages = dialog.getByRole("list", { name: "Languages", exact: true });
  await languages.getByRole("button", { name: /^Go\b/ }).click();
  const gopls = dialog.getByLabel("Go tools").locator('[data-tool="gopls"]');
  await gopls.click();
  await expect(gopls).toContainText("Missing");
  const details = dialog.getByLabel("gopls details");
  await details.getByRole("button", { name: "Install gopls" }).click();
  await expect(details.getByRole("progressbar", { name: "Installing gopls" })).toBeVisible();
  await expect(gopls).toContainText("Installed");
  await expect(gopls).toContainText("1.0.0");
  await expect(details.getByRole("button", { name: "Uninstall" })).toBeVisible();

  // Tools without an installer explain how to get them.
  await languages.getByRole("button", { name: /^Ruby\b/ }).click();
  await expect(dialog.getByLabel("solargraph details")).toContainText("gem install solargraph");
});

test("font picker supports manual families and CJK fallback in browser development", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const preview = dialog.getByRole("textbox", { name: "Font preview", exact: true });
  await dialog.getByRole("textbox", { name: "Search settings" }).fill("Typography Settings");
  await dialog.getByRole("treeitem", { name: "Font", exact: true }).click();
  const family = dialog.getByRole("combobox", { name: "Font", exact: true });
  await family.click();
  await expect(page.getByRole("option", { name: /JetBrains Mono/ })).toBeVisible();
  await family.fill("Maple Mono NF");
  await family.press("Enter");
  await expect(family).toHaveValue("Maple Mono NF");
  // The shipped face is Inter Variable, not a system-installed family named Inter.
  const interLoaded = await page.evaluate(async () => {
    const faces = await document.fonts.load('14px "Inter Variable"');
    return faces.some((face) => face.family.includes("Inter Variable") && face.status === "loaded");
  });
  expect(interLoaded).toBe(true);
  await family.fill("Inter");
  await family.press("Enter");
  // Computed styles drop redundant quotes around single-token families ("Inter" -> Inter).
  await expect(preview).toHaveCSS("font-family", /^Inter, "Inter Variable",/);
  const fallback = dialog.getByRole("combobox", { name: "Fallback font", exact: true });
  await family.fill("Maple Mono NF");
  await family.press("Enter");
  await fallback.fill("Inter");
  await fallback.press("Enter");
  await expect(preview).toHaveCSS("font-family", /Maple Mono NF.*Inter Variable/);
  await fallback.fill("思源宋体");
  await fallback.press("Enter");
  await expect(preview).toHaveCSS("font-family", /思源宋体/);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
});
