import { expect, openFromTree, test } from "./fixtures";

for (const key of ["Enter", "Escape"]) {
  test(`confirmation keeps focus across a deferred editor focus until ${key}`, async ({ workbench: page }) => {
    const editor = await openFromTree(page, "README.md");
    const content = editor.locator(".cm-content");
    await content.click();
    const before = await content.innerText();
    await page.evaluate(async () => {
      const messages = "/src/workbench/messages.tsx";
      const { confirm } = await import(/* @vite-ignore */ messages);
      const content = document.querySelector<HTMLElement>(".cm-content")!;
      void confirm({ title: "Add File to Git", message: "Add README.md?", ok: "Add" }).then((accepted: boolean) => {
        document.body.dataset.confirmed = String(accepted);
      });
      requestAnimationFrame(() => {
        content.focus();
        document.body.dataset.focusAttempted = "true";
      });
    });
    await expect(page.locator("body")).toHaveAttribute("data-focus-attempted", "true");
    await expect(page.getByRole("button", { name: "Add", exact: true })).toBeFocused();
    await page.keyboard.press(key);
    await expect(page.getByRole("dialog", { name: "Add File to Git" })).toBeHidden();
    await expect(page.locator("body")).toHaveAttribute("data-confirmed", String(key === "Enter"));
    await expect(content).toBeFocused();
    await expect(content).toHaveText(before!);
  });
}
