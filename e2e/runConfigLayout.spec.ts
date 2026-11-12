import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function openConfigurations(page: Page) {
  await page.evaluate(async () => {
    const path = "/src/features/run/store.ts";
    const { useRun } = await import(/* @vite-ignore */ path);
    const base = {
      kind: "shell",
      command: "/Users/developer/projects/acme/services/payments/scripts/start-development-server",
      args: ["--watch"],
      cwd: "/Users/developer/projects/acme/services/payments",
      env: { NODE_ENV: "development" },
      detected: false,
      isTest: false,
      debugAdapter: null,
    };
    useRun.setState({
      configs: [
        {
          ...base,
          id: "layout:app",
          name: "Payments development server",
          beforeLaunch: [{ kind: "run", target: "layout:prepare" }],
        },
        { ...base, id: "layout:prepare", name: "Prepare generated sources for the payments development server" },
      ],
      selectedId: "layout:app",
      loaded: true,
      editorOpen: true,
    });
  });
  await expect(page.getByRole("dialog", { name: "Run/Debug Configurations", exact: true })).toBeVisible();
}

test("run configuration sidebar resizes with mouse and keyboard and remembers the layout", async ({
  workbench: page,
}) => {
  await openConfigurations(page);
  const dialog = page.getByRole("dialog", { name: "Run/Debug Configurations", exact: true });
  const handle = dialog.getByRole("separator", { name: "Run configurations", exact: true });
  await expect(handle).toBeVisible();
  const sidebar = dialog.locator("#run-config-navigation");
  const initial = (await sidebar.boundingBox())!.width;
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 55, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(initial + 35);
  const resized = (await sidebar.boundingBox())!.width;
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await openConfigurations(page);
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeCloseTo(resized, 0);
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(resized);
});

test("run configuration fields share a control column including the name", async ({ workbench: page }) => {
  await openConfigurations(page);
  const dialog = page.getByRole("dialog", { name: "Run/Debug Configurations", exact: true });
  const fields = ["Name", "Command", "Working directory"].map((name) =>
    dialog.getByRole("textbox", { name, exact: true }),
  );
  for (const field of fields) await expect(field).toBeVisible();
  const boxes = await Promise.all(fields.map((field) => field.boundingBox()));
  for (const box of boxes) expect(box!.x).toBeCloseTo(boxes[0]!.x, 0);
  expect(boxes[0]!.width).toBeGreaterThan(80);
});

test("resizing the configuration dialog grows its panes and keeps the footer visible", async ({ workbench: page }) => {
  await openConfigurations(page);
  const dialog = page.getByRole("dialog", { name: "Run/Debug Configurations", exact: true });
  const content = dialog.locator("#run-config-content");
  const initial = (await content.boundingBox())!.height;
  const grip = dialog.getByRole("separator", { name: "Resize", exact: true });
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 80, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await content.boundingBox())!.height).toBeGreaterThan(initial + 50);
  const grown = (await grip.boundingBox())!;
  await page.mouse.move(grown.x + grown.width / 2, grown.y + grown.height / 2);
  await page.mouse.down();
  await page.mouse.move(grown.x - 320, grown.y - 400, { steps: 5 });
  await page.mouse.up();
  await expect(dialog.getByRole("button", { name: "OK", exact: true })).toBeInViewport();
  await expect(dialog.getByRole("tree", { name: "Run configurations", exact: true })).toBeVisible();
  await expect.poll(async () => (await content.boundingBox())!.height).toBeLessThan(initial);
  await expect
    .poll(() => dialog.locator("[class*='editForm_']").evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(0);
});

test("configuration templates keep the form and sidebar usable", async ({ workbench: page }) => {
  await openConfigurations(page);
  const dialog = page.getByRole("dialog", { name: "Run/Debug Configurations", exact: true });
  await dialog.getByRole("button", { name: "Edit configuration templates…", exact: true }).click();
  await dialog.getByRole("option", { name: "Shell Script", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "Script path", exact: true })).toBeVisible();
  await expect(dialog.getByRole("separator", { name: "Run configurations", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Back to configurations", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Payments development server");
});

test("Java, npm and Python forms fit narrow and zoomed content panes", async ({ workbench: page }) => {
  for (const kind of ["application", "npm", "pytest"]) {
    await page.evaluate(async (kind) => {
      const store = "/src/features/run/store.ts";
      const types = "/src/features/run/types.ts";
      const { useRun } = await import(/* @vite-ignore */ store);
      const { newConfigOfType, typeFor } = await import(/* @vite-ignore */ types);
      const config = newConfigOfType(typeFor(kind)!, []);
      useRun.setState({ configs: [config], selectedId: config.id, loaded: true, editorOpen: true });
    }, kind);
    const dialog = page.getByRole("dialog", { name: "Run/Debug Configurations", exact: true });
    await expect(dialog).toBeVisible();
    for (const zoom of [1, 1.25]) {
      await page.evaluate((zoom) => document.documentElement.style.setProperty("zoom", String(zoom)), zoom);
      for (const width of [1024, 640, 520]) {
        await page.setViewportSize({ width, height: 820 });
        await expect
          .poll(() => dialog.locator("[class*='editForm_']").evaluate((el) => el.scrollWidth - el.clientWidth), {
            message: `${kind}, ${width}px, ${zoom * 100}%`,
          })
          .toBeLessThanOrEqual(1);
      }
    }
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  }
});

test("Tomcat retains its tabbed form and an independently scrolling panel", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const store = "/src/features/run/store.ts";
    const types = "/src/features/run/types.ts";
    const { useRun } = await import(/* @vite-ignore */ store);
    const { newConfigOfType, typeFor } = await import(/* @vite-ignore */ types);
    const config = newConfigOfType(typeFor("tomcat")!, []);
    useRun.setState({ configs: [config], selectedId: config.id, loaded: true, editorOpen: true });
  });
  const dialog = page.getByRole("dialog", { name: "Run/Debug Configurations", exact: true });
  await expect(dialog).toBeVisible();
  for (const tab of ["Server", "Deployment", "Logs", "Startup/Connection"]) {
    await dialog.getByRole("tab", { name: tab, exact: true }).click();
    const panel = dialog.getByRole("tabpanel");
    await expect(panel).toBeVisible();
    await expect.poll(async () => (await panel.boundingBox())!.height).toBeGreaterThan(100);
  }
});

for (const locale of ["en", "zh"]) {
  test(`${locale} run forms and footer fit narrow and zoomed windows`, async ({ workbench: page }) => {
    await openConfigurations(page);
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("");
    await page.evaluate(async (locale) => {
      const path = "/src/platform/i18n.ts";
      await (await import(/* @vite-ignore */ path)).setLocale(locale);
    }, locale);
    const dialog = page.getByRole("dialog");
    for (const zoom of [1, 1.25]) {
      await page.evaluate((zoom) => document.documentElement.style.setProperty("zoom", String(zoom)), zoom);
      for (const width of [1024, 800, 640, 520]) {
        await page.setViewportSize({ width, height: 820 });
        await expect
          .poll(
            () =>
              dialog.evaluate((el) => {
                const body = el.querySelector<HTMLElement>("[class*='editForm_']")!;
                const footer = el.querySelector<HTMLElement>("[data-dialog-footer]")!;
                const bounds = footer.getBoundingClientRect();
                const buttons = [...footer.querySelectorAll("button")].map((b) => b.getBoundingClientRect());
                return {
                  overflow: body.scrollWidth - body.clientWidth,
                  footerFits: buttons.every((b) => b.left >= bounds.left - 1 && b.right <= bounds.right + 1),
                  footerVisible: bounds.bottom <= window.innerHeight + 1,
                };
              }),
            { message: `${locale}, ${width}px, ${zoom * 100}%` },
          )
          .toMatchObject({ overflow: expect.any(Number), footerFits: true, footerVisible: true });
        await expect
          .poll(() => dialog.locator("[class*='editForm_']").evaluate((el) => el.scrollWidth - el.clientWidth))
          .toBeLessThanOrEqual(1);
        const tasks = dialog.getByRole("list");
        await tasks.scrollIntoViewIfNeeded();
        const bounds = (await tasks.boundingBox())!;
        for (const button of await tasks.getByRole("button").all()) {
          const box = (await button.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(bounds.x - 1);
          expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
        }
      }
    }
  });
}
