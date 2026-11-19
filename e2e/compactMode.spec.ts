import { expect, test } from "./fixtures";

/** Heights IDEA's Islands theme uses in compact mode (`*.compact` keys), against the defaults. */
const SIZES = {
  normal: { titleBar: 40, treeRow: 24, stripeIcon: 20, statusBar: 34, runButton: 30 },
  compact: { titleBar: 32, treeRow: 22, stripeIcon: 16, statusBar: 24, runButton: 26 },
};

async function measure(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const height = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().height ?? null;
    return {
      titleBar: height("header"),
      treeRow: height('[role="tree"][aria-label="Project"] [role="treeitem"]'),
      stripeIcon: height("[data-stripe-button] svg"),
      statusBar: height('footer[aria-label="Status bar"]'),
      runButton: height("[data-run-chooser] + * button"),
    };
  });
}

test("Compact Mode shrinks rows, toolbars, stripes and the status bar like IDEA", async ({ workbench: page }, info) => {
  // Plain-browser mode has no settings backend: set what the toggle action would store.
  const setCompact = (compactMode: boolean) =>
    page.evaluate(async (compactMode) => {
      const projectPath = "/src/platform/project.ts";
      const { useProject } = await import(/* @vite-ignore */ projectPath);
      const settings = useProject.getState().settings;
      useProject.setState({
        settings: {
          ...settings,
          appearance: { ...settings?.appearance, theme: "dark", syncWithOs: false, compactMode },
        },
      });
    }, compactMode);

  await setCompact(false);
  await expect.poll(() => measure(page)).toEqual(SIZES.normal);
  await info.attach("normal", { body: await page.screenshot({ animations: "disabled" }), contentType: "image/png" });

  await setCompact(true);
  await expect(page.locator("html")).toHaveAttribute("data-compact", "");
  await expect.poll(() => measure(page)).toEqual(SIZES.compact);
  await info.attach("compact", { body: await page.screenshot({ animations: "disabled" }), contentType: "image/png" });

  await setCompact(false);
  await expect.poll(() => measure(page)).toEqual(SIZES.normal);
});
