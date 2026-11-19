import { expect, test } from "./fixtures";

for (const [id, selector] of [
  ["build.deployment", "[class*='layout'] > [class*='note']"],
  ["editor.inspections", "[class*='split'] > [class*='details']"],
  ["languages.servers", "[class*='body'] > [class*='language'][aria-label]"],
  ["plugins", "[class*='body'] > [class*='details']"],
  ["agents.list", "section[aria-label='Codex']"],
] as const) {
  test(`${id} keeps its details usable beside the list`, async ({ workbench: page }) => {
    await page.keyboard.press("Meta+,");
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(dialog).toBeVisible();
    await page.evaluate(async (id) => {
      if (id === "agents.list") {
        const path = "/src/features/agents/registry.ts";
        const { tauriCommands } = await import(/* @vite-ignore */ path);
        tauriCommands.providers = async () => [
          {
            id: "codex",
            name: "Codex",
            program: "codex",
            defaultProgram: "codex",
            args: [],
            defaultArgs: [],
            installed: true,
            commandOverridden: false,
            env: {},
            config: [],
            commands: [],
            source: { kind: "builtin" },
          },
        ];
      }
      const path = "/src/features/settings/model/staging.ts";
      (await import(/* @vite-ignore */ path)).selectPage(id);
    }, id);
    const details = dialog.locator(selector).first();
    await expect(details).toBeAttached();
    for (const width of [1000, 640, 520]) {
      await page.setViewportSize({ width, height: 760 });
      expect((await details.boundingBox())!.width).toBeGreaterThan(180);
    }
  });
}

test("every color scheme page keeps its attribute tree visible", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+,");
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 520, height: 760 });
  for (const section of [
    "general",
    "language-defaults",
    "debugger",
    "python",
    "markdown",
    "regexp",
    "java",
    "kotlin",
    "php",
  ]) {
    await page.evaluate(async (section) => {
      const path = "/src/features/settings/model/staging.ts";
      (await import(/* @vite-ignore */ path)).selectPage(`editor.colorScheme.${section}`);
    }, section);
    const tree = page.getByRole("tree", { name: "Color scheme attributes" });
    await expect(tree).toBeAttached();
    expect((await tree.boundingBox())!.width).toBeGreaterThan(150);
  }
});

for (const id of ["editor.fileTemplates", "editor.liveTemplates"]) {
  test(`${id} keeps its editor reachable beside the template list`, async ({ workbench: page }) => {
    await page.keyboard.press("Meta+,");
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
    await page.evaluate(async (id) => {
      const path = "/src/features/settings/model/staging.ts";
      (await import(/* @vite-ignore */ path)).selectPage(id);
    }, id);
    await page.setViewportSize({ width: 520, height: 760 });
    const editor = page.locator("[class*='split'] > [class*='editor']").first();
    await expect(editor).toBeAttached();
    expect((await editor.boundingBox())!.width).toBeGreaterThan(200);
  });
}

test("Project Structure keeps every details pane usable in a compact window", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+;");
  const dialog = page.getByRole("dialog", { name: "Project Structure", exact: true });
  await expect(dialog).toBeVisible();
  await page.setViewportSize({ width: 520, height: 760 });
  for (const section of ["Modules", "Libraries", "Facets", "Artifacts", "SDKs"]) {
    await dialog.getByRole("button", { name: section, exact: true }).click();
    const details = dialog.locator("[class*='splitLayout'] > [class*='detailPane']");
    await expect(details).toBeAttached();
    expect((await details.boundingBox())!.width).toBeGreaterThan(200);
  }
});

test("Project Structure starts with compact navigation and remembers the divider", async ({ workbench: page }) => {
  await page.keyboard.press("Meta+;");
  const dialog = page.getByRole("dialog", { name: "Project Structure", exact: true });
  const sections = dialog.getByRole("navigation", { name: "Project Structure sections" });
  const handle = dialog.getByRole("separator", { name: "Project Structure sections" });
  await expect(handle).toBeVisible();
  const width = async () => (await sections.boundingBox())!.width;
  const initial = await width();
  const layout = (await dialog.getByTestId("project-structure-layout").boundingBox())!.width;
  expect(initial / layout).toBeCloseTo(0.15, 2);

  await handle.press("ArrowRight");
  await expect.poll(width).toBeGreaterThan(initial + 10);
  const resized = await width();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.keyboard.press("Meta+;");
  await expect(handle).toBeVisible();
  await expect.poll(width).toBeCloseTo(resized, 0);
  await sections.getByRole("button", { name: "Modules", exact: true }).click();
  await expect(sections.getByRole("button", { name: "Modules", exact: true })).toHaveAttribute("aria-current", "page");
});
