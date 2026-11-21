import { expect, openFromTree, test } from "./fixtures";

test("Quick Definition keeps the source font and toolbar while switching previews", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1120, height: 780 });
  await openFromTree(page, "App.tsx");
  await page.evaluate(async () => {
    const path = "/src/editor/lsp/popupStore.ts";
    const { openPopup } = await import(/* @vite-ignore */ path);
    const editor = document.querySelector<HTMLElement>(".cm-editor")!;
    const content = editor.querySelector<HTMLElement>(".cm-content")!;
    content.style.fontSize = "19px";
    content.style.lineHeight = "27px";
    const { fontFamily, fontSize, fontWeight, lineHeight, tabSize } = getComputedStyle(content);
    openPopup({
      kind: "definition",
      anchor: { x: 320, y: 160 },
      targets: ["shipping", "billing"].map((group) => ({
        name: "formatTotal",
        firstLine: 2,
        location: {
          path: `/work/acme-api/src/${group}/totals.ts`,
          range: { start: { line: 2, col: 0 }, end: { line: 2, col: 11 } },
        },
        text: `export const formatTotal = "${group}";`,
        language: "typescript",
      })),
      index: 0,
      themeClasses: editor.className,
      codeStyle: { fontFamily, fontSize, fontWeight, lineHeight, tabSize },
    });
  });

  const popup = page.getByRole("dialog", { name: "Definition", exact: true });
  const code = popup.locator("pre");
  await expect(code).toContainText("shipping");
  await expect(code).toHaveCSS("font-size", "19px");
  await expect(code).toHaveCSS("line-height", "27px");
  await expect(popup).toHaveCSS("height", "400px");
  const header = popup.locator("button").filter({ hasText: "formatTotal" });
  await expect(header).toBeVisible();
  await expect(popup.getByText(/shipping[/]totals\.ts:3/)).toBeVisible();

  await popup.getByRole("button", { name: "Next Definition" }).click();
  await expect(code).toContainText("billing");
  await expect(popup.getByText(/billing[/]totals\.ts:3/)).toBeVisible();
  await expect(popup.getByText("2/2")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(code).toContainText("shipping");

  const handle = popup.getByRole("separator", { name: "Resize" });
  const bounds = (await handle.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 56, bounds.y + 50, { steps: 4 });
  await page.mouse.up();
  expect((await popup.boundingBox())!.height).toBeGreaterThan(430);
  await expect(popup.getByRole("button", { name: "Edit Source" })).toBeInViewport({ ratio: 1 });
});
