import { expect, test } from "./fixtures";

test("hovering a tinted project tab keeps its colour", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const tabColors = "/src/workbench/tabColors.ts";
    const windowGroups = "/src/platform/windowGroups.ts";
    const { setTabColorOverride } = await import(/* @vite-ignore */ tabColors);
    const { useWindowGroup } = await import(/* @vite-ignore */ windowGroups);
    setTabColorOverride("/tinted", "#d24b8f");
    useWindowGroup.setState({
      tabs: [
        { label: "main", name: "acme-api", root: "/plain", current: true },
        { label: "second", name: "acme-api", root: "/plain2", current: false },
        { label: "third", name: "acme-api", root: "/tinted", current: false },
      ],
    });
  });
  const plain = page.locator('[data-project-tab="second"]');
  const tinted = page.locator('[data-project-tab="third"]');
  await expect(tinted).toBeVisible();

  // A blank strip inside the tab: right of the hover close button, left of the centred label.
  const strip = async (tab: typeof plain) => {
    const box = (await tab.boundingBox())!;
    return { x: box.x + 34, y: box.y + box.height / 2 - 5, width: 8, height: 10 };
  };
  const shoot = async (tab: typeof plain) => page.screenshot({ clip: await strip(tab), animations: "disabled" });

  await tinted.hover();
  const tintedHover = await shoot(tinted);
  await page.mouse.move(700, 600);
  const tintedRest = await shoot(tinted);
  await plain.hover();
  const plainHover = await shoot(plain);

  // The opaque hover surface must not swallow the tint: a tinted tab renders differently from a plain one.
  expect(tintedHover.equals(plainHover)).toBe(false);
  // Hover still gives feedback on the tinted tab itself.
  expect(tintedHover.equals(tintedRest)).toBe(false);
});
