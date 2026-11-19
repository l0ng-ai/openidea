import { expect, test } from "./fixtures";

test("keeps debug actions and views accessible when the Debug window is docked at the side", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 900, height: 760 });
  await page.evaluate(async () => {
    const debugModule = "/src/features/debugger/state.ts";
    const layoutModule = "/src/workbench/toolwindows/store.ts";
    const servicesModule = "/src/workbench/contributions.ts";
    const { adoptSession } = await import(/* @vite-ignore */ debugModule);
    const { moveToolWindow, setToolWindowSize } = await import(/* @vite-ignore */ layoutModule);
    const { toolWindowService } = await import(/* @vite-ignore */ servicesModule);
    adoptSession(91, { name: "Checkout service", adapter: "java-debug", status: "starting" });
    moveToolWindow("debug", "right");
    setToolWindowSize("right", 300);
    toolWindowService().show("debug", true);
  });

  const pane = page.getByRole("region", { name: "Debug", exact: true });
  const toolbar = pane.getByRole("toolbar", { name: "Debugger actions" });
  const views = pane.getByRole("tablist", { name: "Debug views" });
  await expect(toolbar.getByRole("button", { name: "More", exact: true })).toBeInViewport();
  await expect(views.getByRole("tab", { name: "Console", exact: true })).toBeInViewport();
  await views.getByRole("tab", { name: "Memory", exact: true }).click();
  await expect(views.getByRole("tab", { name: "Memory", exact: true })).toHaveAttribute("aria-selected", "true");
});
