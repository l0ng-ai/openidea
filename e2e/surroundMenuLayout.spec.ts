import type { EditorView } from "@codemirror/view";
import { expect, openFromTree, test } from "./fixtures";

test("Surround With keeps its title and keyboard-selected actions visible in a short window", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 680, height: 320 });
  const editor = await openFromTree(page, "App.tsx");
  const content = editor.locator(".cm-content");
  const source = [
    "const fee = 5;",
    "",
    "function settle(amount: number) {",
    "  const adjusted = amount - fee;",
    "  const receipt = adjusted.toString();",
    "  console.log(receipt);",
    "  return adjusted;",
    "}",
  ].join("\n");
  const selectedText = "  console.log(receipt);";
  await content.evaluate(
    (node, { source, selectedText }) => {
      const view = (node as HTMLElement & { cmTile: { view: EditorView } }).cmTile.view;
      const start = source.indexOf(selectedText);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: source },
        selection: { anchor: start, head: start + selectedText.length },
        scrollIntoView: true,
      });
      view.focus();
    },
    { source, selectedText },
  );
  const openSurround = () =>
    page.evaluate(async () => {
      const module = "/src/platform/actions.ts";
      const { executeAction } = await import(/* @vite-ignore */ module);
      await executeAction("code.surroundWith");
    });

  await openSurround();
  const popup = page.getByRole("dialog", { name: "Surround With", exact: true });
  const title = popup.getByText("Surround With", { exact: true });
  const list = popup.getByRole("listbox");
  await expect(title).toBeInViewport({ ratio: 1 });
  await expect.poll(() => list.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(0);
  await expect.poll(() => popup.evaluate((node) => node.scrollHeight - node.clientHeight)).toBe(0);

  const first = list.getByRole("option", { name: /^1\.?\s+if$/ });
  await expect(first).toHaveAttribute("aria-selected", "true");
  const action = first.getByText("if", { exact: true });
  const mnemonic = first.getByText(/^1\.?$/, { exact: true });
  expect((await mnemonic.boundingBox())!.x + (await mnemonic.boundingBox())!.width).toBeLessThan(
    (await action.boundingBox())!.x,
  );
  expect(await action.evaluate((node) => getComputedStyle(node).fontSize)).toBe("13px");
  await page.keyboard.press("End");
  const last = list.getByRole("option", { name: /!\(expr\)/ });
  await expect(last).toHaveAttribute("aria-selected", "true");
  await expect(last).toBeInViewport({ ratio: 1 });
  await expect(title).toBeInViewport({ ratio: 1 });

  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await expect(content).toBeFocused();
  await expect(content).toContainText("console.log(receipt);");

  await openSurround();
  await expect(first).toBeVisible();
  await page.keyboard.press("1");
  await expect(popup).toBeHidden();
  await expect(content).toContainText(/if \([^)]*\) \{/);
  await expect(content).toContainText("console.log(receipt);");
});
