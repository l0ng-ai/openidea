import { expect, test } from "./fixtures";

test("the conflict actions stay visible beside or below the file list as the dialog resizes", async ({
  workbench: page,
}) => {
  await page.evaluate(async () => {
    const storeModule = "/src/features/vcs/store.ts";
    const dialogModule = "/src/features/vcs/conflictsUi.tsx";
    const { useVcs } = await import(/* @vite-ignore */ storeModule);
    const { showConflictsDialog } = await import(/* @vite-ignore */ dialogModule);
    const root = "/dev/acme-api";
    useVcs.setState({
      root,
      status: Array.from({ length: 24 }, (_, index) => {
        const relPath = `services/payment-configuration/environments/env-${index + 1}.txt`;
        return { path: `${root}/${relPath}`, relPath, staged: null, unstaged: "conflicted", renamedFrom: null };
      }),
    });
    showConflictsDialog();
  });
  const dialog = page.getByRole("dialog", { name: "Conflicts", exact: true });
  const list = dialog.getByRole("listbox", { name: "Conflicted files" });
  const yours = dialog.getByRole("button", { name: "Accept Yours", exact: true });
  await expect(list).toBeFocused();
  const listBox = (await list.boundingBox())!;
  const first = (await yours.boundingBox())!;
  expect(first.x).toBeGreaterThan(listBox.x + listBox.width);
  expect(first.y).toBeLessThan(listBox.y + listBox.height / 2);

  const grip = (await dialog.getByRole("separator", { name: "Resize", exact: true }).boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 36, grip.y + 68, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await list.boundingBox())!.height).toBeGreaterThan(listBox.height + 40);

  await page.setViewportSize({ width: 430, height: 530 });
  await expect(yours).toBeInViewport({ ratio: 1 });
  expect((await yours.boundingBox())!.y).toBeGreaterThan(
    (await list.boundingBox())!.y + (await list.boundingBox())!.height,
  );
  for (const name of ["Accept Theirs", "Merge…"])
    await expect(dialog.getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
  await expect(dialog.locator("[data-dialog-footer]").getByRole("button", { name: "Close" })).toBeInViewport({
    ratio: 1,
  });
  await list.press("End");
  await expect(list.getByRole("option", { selected: true })).toContainText("env-24.txt");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
