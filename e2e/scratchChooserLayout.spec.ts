import { expect, test } from "./fixtures";

test("the scratch language chooser fits short windows and keeps recents separate from search results", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 470, height: 400 });
  const long = "Zebra Configuration Language for Regional Settlement and Reconciliation Pipelines";
  await page.evaluate(async (long) => {
    const scratch = "/src/features/scratch/scratches.ts";
    const store = "/src/features/scratch/store.ts";
    const actions = "/src/platform/actions.ts";
    const { setScratchBackend } = await import(/* @vite-ignore */ scratch);
    const { rememberLanguage } = await import(/* @vite-ignore */ store);
    setScratchBackend({
      dataDir: async () => "/test-app-data",
      listNames: async () => [],
      createDir: async () => {},
      createFile: async () => {},
      languages: async () => [
        ...Array.from({ length: 24 }, (_, i) => {
          const n = String(i + 1).padStart(2, "0");
          return { id: `config-${n}`, name: `Configuration ${n}`, ext: `cfg${n}` };
        }),
        { id: "json", name: "JSON", ext: "json" },
        { id: "python", name: "Python", ext: "py" },
        { id: "zebra", name: long, ext: "zebra" },
      ],
      open: async (path: string) => localStorage.setItem("scratch-layout-opened", path),
    });
    rememberLanguage("json");
    rememberLanguage("python");
    await (await import(/* @vite-ignore */ actions)).executeAction("file.newScratchFile");
  }, long);

  const dialog = page.getByRole("dialog", { name: "New Scratch File", exact: true });
  const input = dialog.getByRole("textbox", { name: "Filter languages" });
  await expect(input).toBeFocused();
  const list = dialog.getByRole("listbox", { name: "Languages" });
  for (let i = 0; i < 3; i++) await input.press("PageDown");
  const last = list.getByRole("option", { name: long, exact: true });
  await expect(last).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(async () => {
      const popup = (await dialog.boundingBox())!;
      const item = (await last.boundingBox())!;
      return item.y + item.height - popup.y - popup.height;
    })
    .toBeLessThanOrEqual(1);
  await expect(last).toBeInViewport({ ratio: 0.99 });
  await expect(last.getByTitle(long)).toBeVisible();
  await expect(input).toBeInViewport({ ratio: 1 });

  await input.fill("python");
  const python = list.getByRole("option", { name: "Python", exact: true });
  await expect(python).toHaveAttribute("aria-selected", "true");
  await expect(list.getByRole("separator")).toHaveCount(0);
  await input.fill("");
  const divider = list.getByRole("separator");
  await expect(divider).toBeVisible();
  await expect(python).toHaveAttribute("aria-selected", "true");
  await input.press("ArrowDown");
  const json = list.getByRole("option", { name: "JSON", exact: true });
  await expect(json).toHaveAttribute("aria-selected", "true");
  await input.press("ArrowDown");
  const first = list.getByRole("option", { name: "Configuration 01", exact: true });
  await expect(first).toHaveAttribute("aria-selected", "true");
  expect((await divider.boundingBox())!.y).toBeLessThan((await first.boundingBox())!.y);
  expect(await input.getAttribute("aria-activedescendant")).toBe(await first.getAttribute("id"));
  await page.setViewportSize({ width: 640, height: 520 });
  await expect
    .poll(async () => {
      const bounds = (await dialog.boundingBox())!;
      return Math.abs(bounds.x + bounds.width / 2 - 320);
    })
    .toBeLessThanOrEqual(1);
  await expect(input).toBeFocused();

  await input.fill("zzz");
  await expect(dialog.getByText("No matching languages")).toBeVisible();
  await input.fill("json");
  await input.press("Enter");
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("scratch-layout-opened")))
    .toBe("/test-app-data/scratches/scratch.json");
});
