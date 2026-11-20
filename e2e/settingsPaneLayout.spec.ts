import { expect, test } from "./fixtures";

for (const [id, selector] of [
  ["build.deployment", "[class*='layout'] > [class*='note']"],
  ["editor.inspections", "[class*='split'] section[class*='details']"],
  ["languages.servers", "[class*='body'] > [class*='language'][aria-label]"],
  ["plugins", "[class*='body'] [class*='details'][aria-label]"],
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

test("Live Templates gives the editor the full settings pane width and keeps variable fields reachable", async ({
  workbench: page,
}) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/features/settings/model/staging.ts";
    (await import(/* @vite-ignore */ path)).selectPage("editor.liveTemplates");
  });
  const list = dialog.getByRole("listbox", { name: "Live templates" });
  const body = dialog.getByRole("textbox", { name: "Template text" });
  await dialog.getByRole("button", { name: "Add Template" }).click();
  await expect(body).toBeVisible();
  const listBounds = (await list.boundingBox())!;
  const bodyBounds = (await body.boundingBox())!;
  expect(bodyBounds.y).toBeGreaterThan(listBounds.y + listBounds.height);
  expect(bodyBounds.width).toBeGreaterThan(listBounds.width - 32);

  const handle = dialog.getByRole("separator", { name: "Resize template panes" });
  await expect(handle).toHaveAttribute("aria-orientation", "horizontal");
  await handle.press("ArrowDown");
  await expect.poll(async () => (await list.boundingBox())!.height).toBeGreaterThan(listBounds.height + 10);

  await dialog.getByRole("textbox", { name: "Abbreviation" }).fill("settlement");
  await dialog.getByRole("textbox", { name: "Filter templates" }).fill("settlement");
  await expect(list.getByRole("option")).toHaveCount(1);
  await expect(list.getByRole("option")).toHaveAttribute("aria-selected", "true");
  await body.fill("record($SETTLEMENT_REFERENCE_IDENTIFIER$, $AMOUNT$)$END$");

  await page.setViewportSize({ width: 520, height: 600 });
  await body.scrollIntoViewIfNeeded();
  await expect(body).toBeInViewport({ ratio: 0.98 });
  const narrowList = (await list.boundingBox())!;
  const narrowBody = (await body.boundingBox())!;
  expect(narrowBody.x + narrowBody.width).toBeLessThanOrEqual(narrowList.x + narrowList.width);
  const variables = dialog.getByRole("table");
  const expression = variables.getByRole("textbox", { name: "SETTLEMENT_REFERENCE_IDENTIFIER expression" });
  await expression.scrollIntoViewIfNeeded();
  await expect(expression).toBeInViewport({ ratio: 1 });
  await expression.fill("fileName()");
  await expect(expression).toHaveValue("fileName()");
  await expect(
    variables.getByRole("checkbox", { name: "Skip SETTLEMENT_REFERENCE_IDENTIFIER if defined" }),
  ).toBeVisible();
  expect(await variables.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
});

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
