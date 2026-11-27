import type { Page } from "@playwright/test";
import type { BeforeLaunchTask } from "../src/bindings";
import { expect, test } from "./fixtures";

test("expands VM options beside the field and returns edited text to the configuration", async ({
  workbench: page,
}) => {
  const original = "-Xmx512m\n-Ddemo.endpoint=https://example.test/" + "long-segment/".repeat(12);
  await page.evaluate(async (vmOptions) => {
    const path = "/src/features/run/store.ts";
    const { useRun } = await import(/* @vite-ignore */ path);
    useRun.setState({
      configs: [
        {
          id: "layout:jvm",
          name: "Catalog service",
          kind: "application",
          command: "java",
          args: ["example.Catalog"],
          params: { mainClass: "example.Catalog", vmOptions },
          env: {},
          cwd: null,
          detected: false,
          isTest: false,
          debugAdapter: "java-debug",
        },
      ],
      editTarget: "layout:jvm",
      loaded: true,
      editorOpen: true,
    });
  }, original);

  const config = page.getByRole("dialog", { name: "Run/Debug Configurations", exact: true });
  const field = config.getByRole("textbox", { name: "VM options", exact: true });
  const expanded = page.getByRole("dialog", { name: "VM options", exact: true });
  const editor = expanded.getByRole("textbox", { name: "VM options", exact: true });
  for (const width of [1100, 560]) {
    await page.setViewportSize({ width, height: 760 });
    await field.scrollIntoViewIfNeeded();
    await field.press("Shift+Enter");
    await expect(editor).toBeFocused();
    await expect
      .poll(async () => {
        const source = (await field.boundingBox())!;
        const popup = (await expanded.boundingBox())!;
        const gap = Math.min(Math.abs(popup.y - source.y - source.height), Math.abs(source.y - popup.y - popup.height));
        return popup.x >= 0 && popup.x + popup.width <= width && gap <= 6;
      })
      .toBe(true);
    await expect.poll(() => editor.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0);
    await editor.fill("-Xmx1g");
    await editor.press("Escape");
    await expect(expanded).toBeHidden();
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(original);
  }

  const expand = config.getByRole("button", { name: "Expand (⇧⏎)", exact: true });
  await expand.click();
  await expect(editor).toBeFocused();
  await editor.fill(original + "\n-Ddemo.mode=local");
  await editor.press("Control+Enter");
  await expect(expanded).toBeHidden();
  await expect(field).toHaveValue(original + "\n-Ddemo.mode=local");
});

async function openConfigurations(page: Page, target?: string, beforeLaunch?: BeforeLaunchTask[]) {
  await page.evaluate(
    async ({ target, beforeLaunch }) => {
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
            target,
            beforeLaunch: beforeLaunch ?? [{ kind: "run", target: "layout:prepare" }],
          },
          { ...base, id: "layout:prepare", name: "Prepare generated sources for the payments development server" },
        ],
        selectedId: "layout:app",
        loaded: true,
        editorOpen: true,
      });
    },
    { target, beforeLaunch },
  );
  await expect(page.getByRole("dialog", { name: "Run/Debug Configurations", exact: true })).toBeVisible();
}

test("before-launch tasks wrap as ordered tags and keep their edit controls", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1150, height: 820 });
  await openConfigurations(page, undefined, [
    { kind: "build" },
    { kind: "buildArtifacts" },
    { kind: "command", target: "make generate" },
  ]);
  const dialog = page.getByRole("dialog", { name: "Run/Debug Configurations", exact: true });
  const tasks = dialog.getByRole("list", { name: "Before launch tasks", exact: true });
  const build = tasks.getByRole("button", { name: "1. Build Project", exact: true });
  const artifacts = tasks.getByRole("button", { name: "2. Build Artifacts", exact: true });
  await tasks.scrollIntoViewIfNeeded();
  await expect(build).toBeVisible();
  expect((await build.boundingBox())!.y).toBeCloseTo((await artifacts.boundingBox())!.y, 0);
  await expect(build).toHaveCSS("font-size", "13px");

  await page.setViewportSize({ width: 520, height: 820 });
  await expect.poll(() => tasks.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  const command = tasks.getByRole("textbox", { name: "Before launch command 3" });
  expect((await command.boundingBox())!.y).toBeGreaterThan((await build.boundingBox())!.y + 20);
  await command.fill("make report");

  await build.press("Enter");
  const actions = page.getByRole("menu", { name: "Task Actions", exact: true });
  const moveDown = actions.getByRole("menuitem", { name: "Move Down", exact: true });
  await expect(moveDown).toBeVisible();
  await moveDown.click();
  await expect(tasks.getByRole("button", { name: "1. Build Artifacts", exact: true })).toBeVisible();
  const moved = tasks.getByRole("listitem").filter({
    has: page.getByRole("button", { name: "2. Build Project", exact: true }),
  });
  await moved.getByRole("button", { name: "Remove Task" }).click();
  await expect(tasks.getByRole("textbox", { name: "Before launch command 2" })).toHaveValue("make report");

  await tasks.getByRole("button", { name: "Add task", exact: true }).click();
  await page.getByRole("menuitem", { name: "Build Project", exact: true }).click();
  await expect(tasks.getByRole("button", { name: "3. Build Project", exact: true })).toBeVisible();
});

test("long run target names leave room for configuration names in the sidebar", async ({ workbench: page }) => {
  const target = "payments-development-shared-staging-runner-west";
  await openConfigurations(page, target);
  const dialog = page.getByRole("dialog", { name: "Run/Debug Configurations", exact: true });
  const tree = dialog.getByRole("tree", { name: "Run configurations", exact: true });
  const row = tree.getByRole("treeitem", { name: /^Payments development server/ });
  const name = row.getByText("Payments development server", { exact: true });
  const badge = row.getByText(`@ ${target}`, { exact: true });
  await expect(badge).toBeVisible();

  for (const width of [1100, 520]) {
    await page.setViewportSize({ width, height: 820 });
    await expect.poll(async () => (await name.boundingBox())!.width).toBeGreaterThan(width === 1100 ? 80 : 50);
    await expect.poll(() => tree.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  }

  await expect(badge).toBeHidden();
  await expect(row).toHaveAttribute("title", new RegExp(`Payments development server @ ${target}`));
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Payments development server");
});

test("the configuration type list scrolls below its search field in a short window", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 780, height: 370 });
  await openConfigurations(page);
  const dialog = page.getByRole("dialog", { name: "Run/Debug Configurations", exact: true });
  await dialog.getByRole("button", { name: "Add New Configuration", exact: true }).click();
  const chooser = page.getByRole("dialog", { name: "Add New Configuration", exact: true });
  const search = chooser.getByRole("textbox", { name: "Search configuration types" });
  const list = chooser.getByRole("listbox", { name: "Configuration types" });
  await expect(search).toBeFocused();
  expect(await chooser.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  expect(await list.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);

  await search.press("End");
  const active = list.getByRole("option", { selected: true });
  await expect(active).toBeInViewport({ ratio: 0.98 });
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(active.locator("svg")).toHaveAttribute("width", "16");
  await expect(search).toBeInViewport({ ratio: 1 });

  await search.fill("Tomcat");
  await expect(list.getByRole("option", { name: "Tomcat Server", selected: true })).toBeVisible();
  await search.press("Enter");
  await expect(chooser).toBeHidden();
  await expect(dialog.getByRole("tab", { name: "Server", exact: true })).toBeVisible();
});

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
    .poll(() => dialog.locator("[class*='_formSettings_']").evaluate((el) => el.scrollHeight - el.clientHeight))
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
          .poll(() => dialog.locator("[class*='_formSettings_']").evaluate((el) => el.scrollWidth - el.clientWidth), {
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
          .poll(() => dialog.locator("[class*='_formSettings_']").evaluate((el) => el.scrollWidth - el.clientWidth))
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
