import { expect, test } from "./fixtures";

test("selected result tabs are inset from the Services pane edge", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const storePath = "/src/features/database/store.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { useDatabase, RESULTS_VIEW } = await import(storePath);
    const { showServiceView } = await import(contributionsPath);
    useDatabase.setState({
      loaded: true,
      results: [],
      activeResult: 0,
      output: [{ id: 1, time: 0, kind: "info", text: "Query completed" }],
    });
    showServiceView(RESULTS_VIEW);
  });
  const output = page
    .getByRole("tablist", { name: "Results", exact: true })
    .getByRole("tab", { name: "Output", exact: true });
  await expect(output).toHaveAttribute("aria-selected", "true");
  const inset = await output.evaluate((element) => {
    const strip = element.closest('[role="tablist"]')?.parentElement;
    if (!strip) throw new Error("Result tab strip is missing");
    return element.getBoundingClientRect().left - strip.getBoundingClientRect().left;
  });
  expect(inset).toBeGreaterThan(0);
});
