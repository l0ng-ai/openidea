import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const primary = "Prepare invoices for the payments staging environment";

async function seedConfigurations(page: Page, mode: "select" | "run") {
  await page.evaluate(
    async ({ name, mode }) => {
      const path = "/src/features/run/store.ts";
      const { useRun } = await import(/* @vite-ignore */ path);
      const configs = [name, ...Array.from({ length: 19 }, (_, i) => `Payments check ${i + 1}`)].map((label, i) => ({
        id: `user:chooser-${i}`,
        name: label,
        kind: "shell",
        command: "node",
        args: ["src/index.ts"],
        cwd: null,
        env: {},
        detected: false,
        isTest: false,
        debugAdapter: null,
      }));
      useRun.setState({ configs, selectedId: configs[0]!.id, chooserMode: mode, chooserOpen: true, loaded: true });
    },
    { name: primary, mode },
  );
}

test("the run chooser fits a long name beside its inline actions and keeps its width while filtering", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1120, height: 680 });
  await seedConfigurations(page, "select");
  const chooser = page.getByRole("dialog", { name: "Run/Debug Configurations", exact: true });
  const label = chooser.getByText(primary, { exact: true });
  await expect(label).toBeVisible();
  const width = (await chooser.boundingBox())!.width;
  expect(width).toBeGreaterThan(340);
  expect(width).toBeLessThanOrEqual(500);
  await expect(chooser.getByRole("button", { name: `Run '${primary}'`, exact: true })).toBeVisible();
  const nameOverflow = await label.evaluate(async (el) => {
    await document.fonts.ready;
    const text = document.createRange();
    text.selectNodeContents(el);
    return text.getBoundingClientRect().width - el.getBoundingClientRect().width;
  });
  expect(nameOverflow).toBeLessThanOrEqual(0);

  const search = chooser.getByRole("textbox", { name: "Search configurations" });
  await search.fill("Payments check 19");
  await expect(chooser.getByText("Payments check 19", { exact: true })).toBeVisible();
  expect((await chooser.boundingBox())!.width).toBeCloseTo(width);
  await page.keyboard.press("Enter");
  await expect(chooser).toBeHidden();
  await expect(page.locator("[data-run-chooser]")).toContainText("Payments check 19");
});

test("in a short window only the list scrolls, leaving the search and shortcuts visible", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 780, height: 280 });
  await seedConfigurations(page, "run");
  const chooser = page.getByRole("dialog", { name: "Run/Debug Configurations", exact: true });
  const list = chooser.getByRole("listbox", { name: "Configurations" });
  const search = chooser.getByRole("textbox", { name: "Search configurations" });
  const hint = chooser.getByText("Hold Shift to Debug, F4 to edit, Delete to remove", { exact: true });
  await expect(search).toBeFocused();
  await expect(hint).toBeInViewport({ ratio: 1 });
  expect(await chooser.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  expect(await list.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);

  await page.keyboard.press("End");
  await expect(chooser.getByRole("option", { name: /Edit Configurations/ })).toBeInViewport({ ratio: 1 });
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(search).toBeInViewport({ ratio: 1 });
  await expect(hint).toBeInViewport({ ratio: 1 });
});
