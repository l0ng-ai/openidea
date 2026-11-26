import type { Page } from "@playwright/test";
import { expect, stubDesktop, test } from "./fixtures";

const file = "/dev/acme-api/shapes.ts";
const literal = "{ width: number; height: number }";
const text = `export function area(shape: ${literal}): number {\n  return shape.width * shape.height;\n}\n`;

/** Opens `file`, stubs tsserver with `actions` (titles and kinds as typescript-language-server reports them) and selects the type literal. */
async function open(page: Page, actions: { title: string; kind: string; declaration: string }[]) {
  await page.evaluate(
    async ({ file, text }) => {
      const backend = "/src/editor/core/backend.ts";
      (await import(/* @vite-ignore */ backend)).docBackend().files.set(file, text);
      const contributions = "/src/workbench/contributions.ts";
      await (await import(/* @vite-ignore */ contributions)).editorService().openFile(file, { focus: true });
    },
    { file, text },
  );
  const content = page.locator(".cm-editor .cm-content").first();
  await expect(content).toContainText("export function area");
  await stubDesktop(page);
  await page.evaluate(
    ({ actions, literal }) => {
      const toAction = (a: (typeof actions)[number]) => ({
        title: a.title,
        kind: a.kind,
        isPreferred: false,
        disabledReason: null,
        edit: null,
        command: null,
        data: a.declaration,
        server: 1,
      });
      window.__ipc.handlers.lsp_code_action_query = () => ({ actions: actions.map(toAction), advertisedKinds: null });
      window.__ipc.handlers.lsp_resolve_code_action = (args) => args.action;
      // tsserver's edit: the declaration above the function, its name in place of the literal.
      window.__ipc.handlers.lsp_execute_code_action = async (args) => {
        const api = "/src/editor/api.ts";
        const { view } = (await import(/* @vite-ignore */ api)).activeEditor();
        const doc = view.state.doc.toString();
        const from = doc.indexOf(literal);
        view.dispatch({
          changes: [
            { from: 0, insert: `${(args.action as { data: string }).data}\n\n` },
            { from, to: from + literal.length, insert: "NewType" },
          ],
        });
        return [];
      };
    },
    { actions, literal },
  );
  await page.evaluate(
    async ({ literal }) => {
      const api = "/src/editor/api.ts";
      const { view } = (await import(/* @vite-ignore */ api)).activeEditor();
      const from = view.state.doc.toString().indexOf(literal);
      view.dispatch({ selection: { anchor: from, head: from + literal.length } });
    },
    { literal },
  );
  return content;
}

async function refactorMenu(page: Page, content: ReturnType<Page["locator"]>, item: string) {
  await content
    .locator(".cm-line")
    .first()
    .click({ button: "right", position: { x: 260, y: 8 } });
  await page.getByRole("menuitem", { name: "Refactor", exact: true }).hover();
  await page.getByRole("menuitem", { name: new RegExp(`^${item}`) }).click();
}

test("Extract Type Alias… declares a type from the selection and renames it in place", async ({ workbench: page }) => {
  const content = await open(page, [
    { title: "Extract to type alias", kind: "refactor.extract.type", declaration: `type NewType = ${literal};` },
    {
      title: "Extract to interface",
      kind: "refactor.extract.interface",
      declaration: "interface NewType {\n    width: number;\n    height: number;\n}",
    },
  ]);
  await refactorMenu(page, content, "Extract Type Alias…");
  await expect(content).toContainText(`type NewType = ${literal};`);
  await expect(content.locator(".cm-lsp-inplace-primary")).toHaveText("NewType");
  await page.keyboard.type("Size");
  await page.keyboard.press("Enter");
  await expect(content.locator(".cm-lsp-inplace")).toHaveCount(0);
  await expect(content).toContainText(`type Size = ${literal};`);
  await expect(content).toContainText("area(shape: Size)");
});

test("Extract Interface… in TypeScript runs tsserver's Extract to interface", async ({ workbench: page }) => {
  const content = await open(page, [
    { title: "Extract to type alias", kind: "refactor.extract.type", declaration: `type NewType = ${literal};` },
    {
      title: "Extract to interface",
      kind: "refactor.extract.interface",
      declaration: "interface NewType {\n    width: number;\n    height: number;\n}",
    },
  ]);
  await refactorMenu(page, content, "Extract Interface…");
  await expect(content).toContainText("interface NewType {");
  await expect(content.locator(".cm-lsp-inplace-primary")).toHaveText("NewType");
});

test("says why when tsserver has no type to extract at the selection", async ({ workbench: page }) => {
  const content = await open(page, []);
  await refactorMenu(page, content, "Extract Interface…");
  await expect(page.getByRole("status")).toHaveText(
    "Cannot perform refactoring. Selected block should represent an object type",
  );
});
