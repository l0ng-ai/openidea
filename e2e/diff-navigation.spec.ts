import type { EditorView } from "@codemirror/view";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function openChain(page: Page) {
  await page.evaluate(async () => {
    const inputPath = "/src/features/vcs/diffInput.ts";
    const { openDiff, withChain } = await import(inputPath);
    localStorage.setItem("openidea.vcs.diffOptions", JSON.stringify({ mode: "split", collapse: false }));
    const files = ["a.ts", "b.ts"].map((name) => ({
      path: `/dev/acme-api/${name}`,
      left: { type: "text", text: "same\nbefore\ntail\n", label: "HEAD" },
      right: { type: "text", text: "same\nafter\ntail\n", label: "Working tree" },
    }));
    await openDiff(withChain(files, 0), { preview: true });
  });
  const toolbar = page.getByRole("toolbar", { name: "Diff", exact: true });
  await expect(toolbar).toContainText("1 difference");
  return toolbar;
}

test("maximizes a diff preview tab and restores its previous layout", async ({ workbench: page }) => {
  const toolbar = await openChain(page);
  const viewer = toolbar.locator("..");
  const project = page.getByRole("tree", { name: "Project", exact: true });
  await expect(project).toBeVisible();
  const before = (await viewer.boundingBox())!;
  await toolbar.getByRole("button", { name: "Maximize Editor", exact: true }).click();
  await expect(project).toBeHidden();
  await expect.poll(async () => (await viewer.boundingBox())!.width).toBeGreaterThan(before.width + 100);
  await expect(toolbar).toContainText("1 difference");
  await toolbar.getByRole("button", { name: "Restore Size", exact: true }).click();
  await expect(project).toBeVisible();
  await expect.poll(async () => Math.abs((await viewer.boundingBox())!.width - before.width)).toBeLessThan(2);
  await expect(toolbar).toContainText("1 difference");
});

test("continues between changed files from toolbar buttons and the keymap", async ({ workbench: page }) => {
  const toolbar = await openChain(page);
  const selected = page.getByRole("tablist", { name: "Editor tabs" }).locator('[aria-selected="true"]');
  await toolbar.getByRole("button", { name: "Next Difference", exact: true }).click();
  await expect(toolbar).toContainText("1 of 1 differences");
  await toolbar.getByRole("button", { name: "Next Difference", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Press again to go to the next file" })).toBeVisible();
  await expect(selected).toContainText("a.ts");
  await page.keyboard.press("F7");
  await expect(selected).toContainText("b.ts");
  await expect(toolbar).toContainText("1 of 1 differences");
  await toolbar.getByRole("button", { name: "Previous Difference", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Press again to go to the previous file" })).toBeVisible();
  await toolbar.getByRole("button", { name: "Previous Difference", exact: true }).click();
  await expect(selected).toContainText("a.ts");
  await expect(toolbar).toContainText("1 of 1 differences");
});

test("skips binary and unchanged siblings and restores after changing preview files", async ({ workbench: page }) => {
  const toolbar = await openChain(page);
  await page.evaluate(async () => {
    const inputPath = "/src/features/vcs/diffInput.ts";
    const { openDiff, withChain } = await import(inputPath);
    const files = [
      ["a.ts", "after\n"],
      ["binary.dat", "\0binary"],
      ["unchanged.ts", "before\n"],
      ["z.ts", "after\n"],
    ].map(([name, text]) => ({
      path: `/dev/acme-api/${name}`,
      left: { type: "text", text: "before\n", label: "HEAD" },
      right: { type: "text", text, label: "Working tree" },
    }));
    await openDiff(withChain(files, 0), { preview: true });
  });
  await expect(toolbar).toContainText("1 difference");
  await page.evaluate(async () => {
    const layoutPath = "/src/workbench/toolwindows/store.ts";
    const { useToolWindowLayout, hideAllToolWindows } = await import(layoutPath);
    useToolWindowLayout.setState({ maximized: "left" });
    hideAllToolWindows();
  });
  await toolbar.locator("..").locator(".cm-content").last().focus();
  const selected = page.getByRole("tablist", { name: "Editor tabs" }).locator('[aria-selected="true"]');
  await page.keyboard.press("F7");
  await page.keyboard.press("F7");
  await expect(selected).toContainText("z.ts");
  await expect(toolbar).toContainText("1 of 1 differences");
  await page.keyboard.press("F7");
  await expect(selected).toContainText("z.ts");
  await page.keyboard.press("Shift+F7");
  await page.keyboard.press("Shift+F7");
  await expect(selected).toContainText("a.ts");
  await toolbar.getByRole("button", { name: "Restore Size", exact: true }).click();
  const maximized = await page.evaluate(async () => {
    const layoutPath = "/src/workbench/toolwindows/store.ts";
    return (await import(layoutPath)).useToolWindowLayout.getState().maximized;
  });
  expect(maximized).toBe("left");
  await expect(toolbar).toBeHidden();
  await expect(page.getByRole("tree", { name: "Project", exact: true })).toBeVisible();
});

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test.describe(`caret navigation with reducedMotion=${reducedMotion}`, () => {
    test.use({ reducedMotion });
    for (const [mode, alignChanges, side] of [
      ["split", false, 0],
      ["split", false, 1],
      ["split", true, 0],
      ["split", true, 1],
      ["unified", false, 0],
    ] as const) {
      test(`centres the visible caret during ${mode} navigation (aligned=${alignChanges}, pane=${side})`, async ({
        workbench: page,
      }) => {
        await page.evaluate(
          async ({ mode, alignChanges }) => {
            const inputPath = "/src/features/vcs/diffInput.ts";
            const { openDiff } = await import(inputPath);
            localStorage.setItem(
              "openidea.vcs.diffOptions",
              JSON.stringify({ mode, alignChanges, collapse: false, syncScroll: true }),
            );
            const lines = Array.from({ length: 800 }, (_, i) => `const value${i} = ${i};`);
            const right = [...lines];
            for (const i of [100, 400, 700]) right[i] = `const changed${i} = ${i};`;
            await openDiff({
              path: "/dev/acme-api/navigation.ts",
              left: { type: "text", text: lines.join("\n"), label: "Before" },
              right: { type: "text", text: right.join("\n"), label: "After" },
            });
          },
          { mode, alignChanges },
        );
        const toolbar = page.getByRole("toolbar", { name: "Diff", exact: true });
        await expect(toolbar).toContainText("3 differences");
        const pane = toolbar.locator("..").locator(".cm-editor").nth(side);
        await pane.locator(".cm-content").focus();
        const check = async (line: number) => {
          await expect(pane).toHaveClass(/cm-focused/);
          await expect
            .poll(() =>
              pane.locator(".cm-content").evaluate((content) => {
                const view = (content as HTMLElement & { cmTile: { view: EditorView } }).cmTile.view;
                const head = view.state.selection.main.head;
                const line = view.state.doc.lineAt(head);
                const outer = content.closest<HTMLElement>(".cm-mergeView");
                const scroller = outer && outer.scrollHeight > outer.clientHeight ? outer : view.scrollDOM;
                const rect = scroller.getBoundingClientRect();
                const caret = view.coordsAtPos(head);
                const y = caret ? (caret.top + caret.bottom) / 2 : null;
                return {
                  line: line.number,
                  column: head - line.from,
                  centred: y !== null && Math.abs(y - rect.top - scroller.clientHeight / 2) < 3,
                  cursor: getComputedStyle(view.dom.querySelector(".cm-cursor")!).display !== "none",
                  blinking: /cm-blink/.test(getComputedStyle(view.dom.querySelector(".cm-cursorLayer")!).animationName),
                };
              }),
            )
            .toEqual({ line, column: 0, centred: true, cursor: true, blinking: true });
          if (mode === "split" && !alignChanges) {
            const tops = await toolbar
              .locator("..")
              .locator(".cm-scroller")
              .evaluateAll((els) => els.map((el) => el.scrollTop));
            expect(Math.abs(tops[0]! - tops[1]!)).toBeLessThan(2);
          }
        };
        await toolbar.getByRole("button", { name: "Next Difference", exact: true }).click();
        await check(101);
        await page.keyboard.press("F7");
        await check(401);
        await page.keyboard.press("F7");
        await check(701);
        await toolbar.getByRole("button", { name: "Previous Difference", exact: true }).click();
        await check(401);
        await page.keyboard.press("Shift+F7");
        await check(101);
      });
    }
  });
}
