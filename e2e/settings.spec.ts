import { expect, stubDesktop, test } from "./fixtures";

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
  await vcs.click();
  await page.getByRole("option", { name: "<none>", exact: true }).click();
  await expect(vcs).toHaveText("<none>");

  await toolbar.getByRole("button", { name: "Add", exact: true }).click();
  const added = table.getByRole("row").filter({ hasText: "billing-audit-adapter" });
  await expect(added.getByText("billing-audit-adapter", { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(added).toHaveAttribute("aria-selected", "true");
  await toolbar.getByRole("button", { name: "Remove", exact: true }).click();
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
  await expect(dialog.getByLabel("Font preview")).toHaveCSS("font-family", /^Inter, "Inter Variable",/);
  const fallback = dialog.getByRole("combobox", { name: "Fallback font", exact: true });
  await family.fill("Maple Mono NF");
  await family.press("Enter");
  await fallback.fill("Inter");
  await fallback.press("Enter");
  await expect(dialog.getByLabel("Font preview")).toHaveCSS("font-family", /Maple Mono NF.*Inter Variable/);
  await fallback.fill("思源宋体");
  await fallback.press("Enter");
  await expect(dialog.getByLabel("Font preview")).toHaveCSS("font-family", /思源宋体/);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
});
