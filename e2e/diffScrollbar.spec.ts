/**
 * The horizontal scrollbar of a diff pane: with wrapping off and lines wider
 * than the pane, it must sit at the pane's bottom edge — reachable without
 * scrolling the diff content to its end — in every viewer mode.
 */
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { readSides, tempDiffRepo } from "./diffRepo";
import { expect, test } from "./fixtures";

let repo = "";
test.beforeAll(() => {
  repo = tempDiffRepo();
});
test.afterAll(() => rmSync(dirname(repo), { recursive: true, force: true }));

for (const [name, options] of [
  ["side-by-side without alignment", { mode: "split", alignChanges: false }],
  ["side-by-side aligned", { mode: "split", alignChanges: true }],
  ["unified", { mode: "unified", alignChanges: false }],
] as const) {
  test(`the horizontal scrollbar spans the pane viewport (${name})`, async ({ workbench: page }) => {
    const path = "src/soft-wrap.ts";
    const { left, right } = readSides(repo, path);
    await page.evaluate(
      async ({ path, left, right, options }) => {
        localStorage.setItem("openidea.vcs.diffOptions", JSON.stringify(options));
        const actions = "/src/platform/actions.ts";
        const { executeAction } = await import(/* @vite-ignore */ actions);
        await executeAction("diff.compareTexts", {
          path,
          title: path,
          left: { text: left, label: "HEAD" },
          right: { text: right, label: "Working tree" },
        });
      },
      {
        path,
        left,
        right,
        options: {
          ...options,
          ignore: "none",
          highlight: "words",
          collapse: true,
          syncScroll: true,
          softWrap: false,
        },
      },
    );
    const geometry = await page
      .locator(".cm-editor.cm-merge-b")
      .first()
      .evaluate((ed) => {
        const scroller = ed.querySelector<HTMLElement>(".cm-scroller")!;
        const host = (ed.closest(".cm-mergeView") ?? ed).parentElement!;
        return {
          wide: scroller.scrollWidth,
          clientW: scroller.clientWidth,
          scrollerBottom: scroller.getBoundingClientRect().bottom,
          viewportBottom: host.getBoundingClientRect().bottom,
        };
      });
    // The lines are far wider than the pane: there is something to scroll.
    expect(geometry.wide).toBeGreaterThan(geometry.clientW + 1_000);
    // The scroller spans the pane's viewport, so its horizontal scrollbar is at
    // the bottom edge instead of the content's end.
    expect(geometry.scrollerBottom).toBeCloseTo(geometry.viewportBottom, 0);
  });
}
