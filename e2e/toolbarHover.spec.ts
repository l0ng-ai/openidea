import { expect, openFromTree, test } from "./fixtures";

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: toolbar icon buttons provide hover feedback without changing their layout or icons`, async ({
    workbench: page,
  }) => {
    const gear = page.getByRole("button", { name: "IDE and Project Settings", exact: true });
    await gear.click();
    await page.getByRole("menuitem", { name: "Theme", exact: true }).hover();
    await page
      .getByRole("menuitemcheckbox", { name: `Islands ${theme === "light" ? "Light" : "Dark"}`, exact: true })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

    const toolbar = page.locator("header").first();
    const disabledRun = toolbar.getByRole("button", { name: "Run", exact: true });
    await expect(disabledRun).toBeDisabled();
    await disabledRun.hover();
    await expect(disabledRun).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

    await openFromTree(page, "App.tsx");
    await page.locator("[data-run-chooser]").click();
    await page.getByRole("option", { name: "Current File", exact: true }).click();
    const project = page.getByRole("region", { name: "Project", exact: true });
    const buttons = [
      ...["Select Opened File", "Expand All", "Collapse All", "Options", "Hide"].map((name) =>
        project.getByRole("button", { name, exact: true }),
      ),
      ...[
        "Run Current File",
        "Debug Current File",
        "More Actions",
        "Search Everywhere",
        "IDE and Project Settings",
      ].map((name) => toolbar.getByRole("button", { name, exact: true })),
    ];
    for (const button of buttons) {
      await page.mouse.move(700, 500);
      const bounds = await button.boundingBox();
      const iconColors = await button.locator("svg [fill], svg [stroke]").evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node);
          return { fill: style.fill, stroke: style.stroke };
        }),
      );
      await expect(button).toBeEnabled();
      // Hover inside the hit target but outside its centred icon.
      await button.hover({ position: { x: bounds!.width / 2, y: 1 } });
      await expect(button).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      expect(await button.boundingBox()).toEqual(bounds);
      if (/^(Run|Debug) Current File$/.test((await button.getAttribute("aria-label")) ?? "")) {
        expect(
          await button.locator("svg [fill], svg [stroke]").evaluateAll((nodes) =>
            nodes.map((node) => {
              const style = getComputedStyle(node);
              return { fill: style.fill, stroke: style.stroke };
            }),
          ),
        ).toEqual(iconColors);
      }
      await button.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(button).toBeFocused();
      await expect(button).toHaveCSS("outline-style", "solid");
      await expect(button).toHaveCSS("outline-width", "2px");
    }

    const expand = project.getByRole("button", { name: "Expand All", exact: true });
    await expand.hover();
    const hover = await expand.evaluate((button) => getComputedStyle(button).backgroundColor);
    await page.mouse.down();
    await expect(expand).not.toHaveCSS("background-color", hover);
    await page.mouse.up();
    await expect(project.getByRole("treeitem", { name: "src", exact: true })).toHaveAttribute("aria-expanded", "true");
    await project.getByRole("button", { name: "Collapse All", exact: true }).click();
    await expect(project.getByRole("treeitem", { name: "src", exact: true })).toHaveAttribute("aria-expanded", "false");

    await project.getByRole("button", { name: "Options", exact: true }).click();
    await expect(page.getByRole("menu", { name: "Project options", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await toolbar.getByRole("button", { name: "More Actions", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: /^Edit Configurations…/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await toolbar.getByRole("button", { name: "Search Everywhere", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Search Everywhere", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await project.getByRole("button", { name: "Hide", exact: true }).click();
    await expect(project).toBeHidden();
  });
}
