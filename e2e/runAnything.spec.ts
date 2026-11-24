import { expect, test } from "./fixtures";

test("Run Anything keeps its command field and shortcuts visible as its results scroll", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1080, height: 740 });
  await page.evaluate(async () => {
    const projectModule = "/src/platform/project.ts";
    const contributionsModule = "/src/workbench/contributions.ts";
    const historyModule = "/src/features/run-anything/model.ts";
    const [{ useProject }, { registerRunAnythingProvider }, { pushHistory }] = await Promise.all([
      import(/* @vite-ignore */ projectModule),
      import(/* @vite-ignore */ contributionsModule),
      import(/* @vite-ignore */ historyModule),
    ]);
    const root = useProject.getState().project.root;
    for (const command of ["git status", "git diff --stat", "pnpm lint", "pnpm test"]) pushHistory(root, command);
    const tasks = Array.from({ length: 8 }, (_, i) => {
      const command = `npm run verify-${i + 1}`;
      return {
        key: command,
        label: `Verify checkout configuration ${i + 1}`,
        detail: "checkout-service / workspace verification",
        completion: command,
        run: () => {
          document.body.dataset.runAnythingCommand = command;
        },
      };
    });
    registerRunAnythingProvider({
      id: "test-verify",
      order: -100,
      group: "Run Configurations",
      items: (line: string) => tasks.filter((task) => task.completion.includes(line)),
    });
  });
  await page.keyboard.press("Control");
  await page.keyboard.press("Control");

  const popup = page.getByRole("dialog", { name: "Run Anything", exact: true });
  const field = popup.getByLabel("Command line", { exact: true });
  const fieldSurface = field.locator("..");
  const commandRow = fieldSurface.locator("..");
  const results = popup.getByRole("listbox", { name: "Run Anything entries" });
  const hint = popup.getByText(/Enter to run, Tab to complete|Tab to complete, Enter to run/);
  await expect(field).toBeFocused();
  await expect(fieldSurface).toHaveCSS("box-shadow", "none");
  await expect(commandRow).toHaveCSS("border-bottom-width", "1px");
  await expect(commandRow).toHaveCSS("border-left-width", "0px");
  const focusedDivider = await commandRow.evaluate((el) => getComputedStyle(el).borderBottomColor);
  await page.setViewportSize({ width: 560, height: 340 });
  await expect
    .poll(async () => {
      const [shell, footer] = await Promise.all([popup.boundingBox(), hint.boundingBox()]);
      return (
        !!shell &&
        !!footer &&
        Math.abs(shell.x - (560 - shell.width) / 2) < 2 &&
        shell.x >= 14 &&
        footer.y + footer.height <= shell.y + shell.height + 1
      );
    })
    .toBe(true);
  await expect.poll(() => results.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  await field.fill("verify");
  await field.press("ArrowDown");
  await expect(field).toHaveValue("npm run verify-1");
  const selected = results.getByRole("option", { selected: true });
  await expect(selected).toContainText("Verify checkout configuration 1");
  await expect(field).toHaveAttribute("aria-activedescendant", (await selected.getAttribute("id"))!);
  await field.press("Tab");
  await expect(field).toHaveValue("npm run verify-1");
  await expect(field).toBeFocused();
  await field.press("Shift+Tab");
  const history = popup.getByRole("button", { name: "Clear History" });
  await expect(history).toBeFocused();
  await expect(commandRow).not.toHaveCSS("border-bottom-color", focusedDivider);
  await history.press("Enter");
  await expect(history).toBeHidden();
  await expect(field).toBeFocused();
  await field.press("ArrowDown");
  await field.press("Enter");
  await expect(popup).toBeHidden();
  await expect(page.locator("body")).toHaveAttribute("data-run-anything-command", "npm run verify-1");
});
