/**
 * Pull Members Up / Push Members Down. The language server is stubbed at the IPC layer: the
 * Java side is covered by plugins/java-usages/tests/hierarchy.py against a real JDT LS.
 */
import type { Page } from "@playwright/test";
import { expect, openFromTree, test } from "./fixtures";

const captureDir = process.env.OPENIDEA_ACCEPTANCE_DIR;

/** Opens the dialog as the action does after the server answered, for the editor's view. */
async function openDialog(page: Page, kind: "pullUp" | "pushDown") {
  await page.evaluate(async (kind) => {
    const module = "/src/editor/refactor/hierarchy.ts";
    const { useHierarchyDialog } = await import(/* @vite-ignore */ module);
    const view = (document.querySelector(".cm-content") as unknown as { cmTile: { view: { state: { doc: unknown } } } })
      .cmTile.view;
    const pullUp = kind === "pullUp";
    useHierarchyDialog.setState({
      request: {
        seq: 1,
        view,
        kind,
        doc: 1,
        pos: { line: 0, col: 0 },
        text: view.state.doc,
        info: {
          className: pullUp ? "Dog" : "Animal",
          targets: pullUp
            ? [
                { id: "animal", name: "Animal", qualifiedName: "zoo.Animal", interface: false },
                { id: "speaker", name: "Speaker", qualifiedName: "zoo.Speaker", interface: true },
              ]
            : [
                { id: "dog", name: "Dog", qualifiedName: "zoo.Dog", interface: false },
                { id: "cat", name: "Cat", qualifiedName: "zoo.Cat", interface: false },
              ],
          members: pullUp
            ? [
                { id: "tail", label: "tail : int", kind: "field", selected: false, abstractable: false },
                { id: "bark", label: "bark() : String", kind: "method", selected: true, abstractable: true },
                { id: "wag", label: "wag() : int", kind: "method", selected: false, abstractable: true },
              ]
            : [
                { id: "name", label: "name : String", kind: "field", selected: false, abstractable: false },
                { id: "describe", label: "describe() : String", kind: "method", selected: true, abstractable: true },
              ],
        },
      },
    });
  }, kind);
}

/** Stubs the server's check and the edit application; returns what reached them. */
async function stubServer(page: Page, problems: { severity: string; message: string }[]) {
  await page.evaluate(async (problems) => {
    const module = "/src/platform/ipc.ts";
    const { commands } = await import(/* @vite-ignore */ module);
    // Only the stubbed commands answer; window lookups by other features keep working.
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        transformCallback: () => 1,
        invoke: async () => null,
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      },
    });
    const seen = ((window as unknown as { hierarchySeen: unknown[] }).hierarchySeen = [] as unknown[]);
    commands.lspHierarchyRefactor = async (...args: unknown[]) => {
      seen.push({ refactor: args.slice(3) });
      return {
        status: "ok",
        data: {
          problems,
          edit: {
            files: [
              {
                kind: "edit",
                path: "/dev/acme-api/README.md",
                edits: [{ range: { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } }, new_text: "" }],
              },
            ],
          },
        },
      };
    };
    commands.applyWorkspaceEdit = async (edit: unknown) => {
      seen.push({ apply: edit });
      return { status: "ok", data: null };
    };
  }, problems);
}

const seen = (page: Page) => page.evaluate(() => (window as unknown as { hierarchySeen: unknown[] }).hierarchySeen);

test("the editor's Refactor menu offers Pull Members Up and Push Members Down", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "README.md");
  await editor.locator(".cm-content").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Refactor", exact: true }).hover();
  await expect(page.getByRole("menuitem", { name: /^Pull Members Up…/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /^Push Members Down…/ })).toBeVisible();
  if (captureDir) await page.screenshot({ path: `${captureDir}/01-refactor-menu.png` });
  await page.keyboard.press("Escape");
});

test("Pull Members Up: members, interface destination, conflicts, then the edit", async ({ workbench: page }) => {
  await openFromTree(page, "README.md");
  await openDialog(page, "pullUp");
  const dialog = page.getByRole("dialog", { name: "Pull Members Up" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Pull up members of Dog to:")).toBeVisible();
  const member = (label: string) => dialog.getByRole("row").filter({ hasText: label });
  // The member at the caret starts checked; fields can't be made abstract.
  await expect(member("bark() : String").getByRole("checkbox").first()).toBeChecked();
  await expect(member("wag() : int").getByRole("checkbox").first()).not.toBeChecked();
  await member("tail : int").getByRole("checkbox").first().check();
  await expect(member("tail : int").getByRole("checkbox", { name: "Make abstract" })).toBeDisabled();
  if (captureDir) await page.screenshot({ path: `${captureDir}/02-pull-up-dialog.png` });

  // To an interface, methods are declared abstract there.
  await dialog.getByRole("button", { name: "Destination class" }).click();
  await page.getByRole("option", { name: /zoo\.Speaker/ }).click();
  const abstractBark = member("bark() : String").getByRole("checkbox", { name: "Make abstract" });
  await expect(abstractBark).toBeChecked();
  await expect(abstractBark).toBeDisabled();
  await expect(dialog.getByText("Methods pulled up to an interface are declared abstract there.")).toBeVisible();
  if (captureDir) await page.screenshot({ path: `${captureDir}/03-pull-up-to-interface.png` });

  await stubServer(page, [
    { severity: "error", message: "Field 'zoo.Dog.tail' is not accessible from type 'zoo.Speaker'" },
  ]);
  await dialog.getByRole("button", { name: "Refactor", exact: true }).click();
  const problems = page.getByRole("alertdialog").or(page.getByRole("dialog", { name: "Problems Detected" }));
  await expect(problems.getByText(/is not accessible from type/)).toBeVisible();
  if (captureDir) await page.screenshot({ path: `${captureDir}/04-problems-detected.png` });
  // Cancel: nothing applied, the dialog stays.
  await problems.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(await seen(page)).toEqual([
    {
      refactor: [
        "pullUp",
        "speaker",
        [
          { id: "tail", makeAbstract: false },
          { id: "bark", makeAbstract: true },
        ],
      ],
    },
  ]);
  // Continue: the edit is applied and the dialog closes.
  await dialog.getByRole("button", { name: "Refactor", exact: true }).click();
  await problems.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await seen(page)).some((s) => "apply" in (s as object))).toBe(true);
});

test("Push Members Down keeps an abstract declaration when asked", async ({ workbench: page }) => {
  await openFromTree(page, "README.md");
  await openDialog(page, "pushDown");
  const dialog = page.getByRole("dialog", { name: "Push Members Down" });
  await expect(dialog.getByText("Push members of Animal down to:")).toBeVisible();
  await expect(dialog.getByText("Dog, Cat")).toBeVisible();
  const describe = dialog.getByRole("row").filter({ hasText: "describe() : String" });
  await describe.getByRole("checkbox", { name: "Keep abstract" }).check();
  if (captureDir) await page.screenshot({ path: `${captureDir}/05-push-down-dialog.png` });
  await stubServer(page, []);
  await dialog.getByRole("button", { name: "Refactor", exact: true }).click();
  await expect(dialog).toBeHidden();
  const calls = await seen(page);
  expect(calls[0]).toEqual({ refactor: ["pushDown", null, [{ id: "describe", makeAbstract: true }]] });
  expect(calls.some((s) => "apply" in (s as object))).toBe(true);
});
