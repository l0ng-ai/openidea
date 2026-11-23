import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

async function openDialog(page: Page, id: "find.structural" | "find.replaceStructural") {
  await stubDesktop(page);
  await page.evaluate(async (id) => {
    window.__ipc.handlers.structural_languages = () => [
      { id: "java", name: "Java" },
      { id: "typescript", name: "TypeScript" },
    ];
    window.__ipc.handlers.structural_validate = () => null;
    const actionsModule = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    await executeAction(id);
  }, id);
}

test("Structural Search puts language selection beside the taller template editor", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1080, height: 720 });
  await openDialog(page, "find.structural");
  const dialog = page.getByRole("dialog", { name: "Structural Search" });
  const editor = dialog.getByRole("textbox", { name: "Search template" });
  const label = dialog.locator("label").filter({ hasText: /^Search template$/ });
  const language = dialog.getByRole("button", { name: "Language", exact: true });
  await expect(editor).toBeFocused();
  await expect(language).toHaveText("Java");

  const { x, y, width, height } = (await editor.boundingBox())!;
  const caption = (await label.boundingBox())!;
  const picker = (await language.boundingBox())!;
  expect(Math.abs(caption.y + caption.height / 2 - (picker.y + picker.height / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs(caption.x - x)).toBeLessThanOrEqual(1);
  expect(Math.abs(picker.x + picker.width - (x + width))).toBeLessThanOrEqual(1);
  expect(y - (picker.y + picker.height)).toBeLessThanOrEqual(6);
  expect(Math.abs(height - 150)).toBeLessThanOrEqual(1);

  await language.click();
  await page.getByRole("option", { name: "TypeScript" }).click();
  await editor.fill("console.log($value$)");
  await expect
    .poll(() => ipcCalls(page, "structural_validate"))
    .toContainEqual({
      query: { language: "typescript", pattern: "console.log($value$)", replacement: null, maxMatches: 0 },
    });
  await expect(dialog.getByRole("button", { name: "Find", exact: true })).toBeEnabled();
});

test("Structural Replace uses editor typography and fits the template controls in a narrow window", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 400, height: 620 });
  await openDialog(page, "find.replaceStructural");
  const dialog = page.getByRole("dialog", { name: "Structural Replace" });
  const search = dialog.getByRole("textbox", { name: "Search template" });
  const replacement = dialog.getByRole("textbox", { name: "Replace template" });
  await expect(search).toBeFocused();
  await page.evaluate(async () => {
    const projectModule = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ projectModule);
    const { settings, project } = useProject.getState();
    const current = settings ?? project?.settings;
    if (!current) throw new Error("Expected project settings");
    useProject.setState({
      settings: { ...current, editor: { ...current.editor, fontFamily: "Consolas", fontSize: 17, lineHeight: 26 } },
    });
  });

  for (const template of [search, replacement]) {
    await expect(template).toHaveCSS("font-family", /^Consolas,/);
    await expect(template).toHaveCSS("font-size", "17px");
    await expect(template).toHaveCSS("line-height", "26px");
    const box = (await template.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(400);
    expect(Math.abs(box.height - 105)).toBeLessThanOrEqual(1);
  }
  await expect(dialog.getByRole("radio", { name: "Whole project" })).toBeInViewport();
  await replacement.fill("Objects.equals($a$, $b$)");
  await expect(replacement).toHaveValue("Objects.equals($a$, $b$)");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeInViewport();
});
