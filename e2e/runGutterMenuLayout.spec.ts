import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const prefix = "reconcile-regional-inventory-and-rebuild-order-settlement-cache-for-warehouse-";
const east = prefix + "east-stage";
const west = prefix + "west-stage";
const content = JSON.stringify(
  { name: "warehouse-tools", scripts: { [east]: "node east.js", [west]: "node west.js", build: "node build.js" } },
  null,
  2,
);

test("the npm gutter keeps distinct ends of long names and runs the selected script", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 440, height: 520 });
  await stubDesktop(page);
  await page.evaluate(async (text) => {
    const backendPath = "/src/editor/core/backend.ts";
    const servicePath = "/src/workbench/contributions.ts";
    const { docBackend } = await import(/* @vite-ignore */ backendPath);
    const { editorService } = await import(/* @vite-ignore */ servicePath);
    const path = "/dev/acme-api/package.json";
    docBackend().files.set(path, text);
    const handlers = window.__ipc.handlers;
    handlers.fs_probe = () => ({ size: text.length, binary: false, tooLarge: false });
    handlers.fs_read_text = ({ path }) => docBackend().files.get(String(path)) ?? "";
    handlers.fs_read_dir = () => [];
    handlers.run_configs = () => [];
    handlers.run_start = ({ config }) => ({
      id: 7,
      configId: (config as { id: string }).id,
      name: (config as { name: string }).name,
      pid: 4242,
      running: true,
      pty: false,
    });
    await editorService().openFile(path);
  }, content);
  const editor = page.locator(".cm-editor");
  const menu = page.getByRole("menu", { name: "Context menu" });
  for (const name of [east, west]) {
    await editor.getByTitle("Run '" + name + "'", { exact: true }).click();
    const label = "Run 'npm run " + name + "'";
    const run = menu.getByRole("menuitem", { name: label, exact: true });
    const end = run.getByText(label.slice(-12), { exact: true });
    await expect(end).toBeVisible();
    await expect(end.locator("..")).toHaveAttribute("title", label);
    expect(await end.evaluate((node) => node.clientWidth >= node.scrollWidth)).toBe(true);
    const start = end.locator("..").locator(":scope > span").first();
    expect(await start.evaluate((node) => node.clientWidth < node.scrollWidth)).toBe(true);
    await expect(start).toHaveCSS("text-overflow", "ellipsis");
    const titleUnderPointer = await start.evaluate((node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return document.elementFromPoint(x + width / 2, y + height / 2)?.getAttribute("title");
    });
    expect(titleUnderPointer).toBe(label);
    await expect(run).toBeFocused();
    if (name === east) await run.press("Escape");
    else await run.press("Enter");
    await expect(menu).toBeHidden();
  }
  await expect
    .poll(async () => ipcCalls(page, "run_start"))
    .toMatchObject([{ config: { args: ["run", west], kind: "npm" } }]);
});
