import type { EditorView } from "@codemirror/view";
import type { Page } from "@playwright/test";
import type { MemoryBackend } from "../src/editor/core/backend";
import { expect, stubDesktop, test } from "./fixtures";

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

test("includes and excludes original and working lines in a unified diff selection", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const path = "/dev/acme-api/lines.txt";
    const before = "start\nold one\nold two\nold three\nend\n";
    const after = "start\nnew one\nnew two\nnew three\nend\n";
    const handlers = window.__ipc.handlers;
    handlers.vcs_file_at = () => before;
    handlers.vcs_diff_hunks = () => [
      { kind: "modified", start: 1, lines: 3, oldStart: 1, oldLines: 3, oldText: "old one\nold two\nold three\n" },
    ];
    handlers.fs_probe = () => ({ size: after.length, binary: false, tooLarge: false });
    const backendPath = "/src/editor/core/backend.ts";
    const { docBackend } = await import(/* @vite-ignore */ backendPath);
    (docBackend() as MemoryBackend).files.set(path, after);
    const storePath = "/src/features/vcs/store.ts";
    const { useVcs } = await import(/* @vite-ignore */ storePath);
    const status = { path, relPath: "lines.txt", unstaged: "modified", staged: null, renamedFrom: null };
    useVcs.setState({ status: [status], byPath: new Map([[path, status]]) });
    const inputPath = "/src/features/vcs/diffInput.ts";
    const { openDiff } = await import(/* @vite-ignore */ inputPath);
    await openDiff({ path, left: { type: "rev", rev: "HEAD" }, right: { type: "worktree" }, mode: "unified" });
  });

  const marker = page.locator(".cm-include-hunk");
  await expect(marker).toBeChecked();
  const old = page.locator(".cm-deletedLine").filter({ hasText: "old two" });
  await old.click({ button: "right", position: { x: 14, y: 8 } });
  const menu = page.getByRole("menu", { name: "Context menu" });
  await menu.getByRole("menuitem", { name: "Exclude Selected Lines from Commit" }).click();
  await expect(marker).toHaveJSProperty("indeterminate", true);

  const start = (await old.boundingBox())!;
  const end = (await page.locator(".cm-line").filter({ hasText: "new one" }).boundingBox())!;
  await page.mouse.move(start.x + 1, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + 48, end.y + end.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(".cm-unified-commit-selected")).toHaveText(["old two", "old three", "new one"]);
  const selectionColors = await page
    .locator(".cm-unified-commit-selected")
    .evaluateAll((rows) => rows.map((row) => getComputedStyle(row).backgroundColor));
  expect(new Set(selectionColors).size).toBe(1);
  await old.click({ button: "right", position: { x: 16, y: 8 } });
  await menu.getByRole("menuitem", { name: "Exclude Selected Lines from Commit" }).click();

  const excluded = await page.evaluate(async () => {
    const storePath = "/src/features/vcs/commitStore.ts";
    const { useCommit } = await import(/* @vite-ignore */ storePath);
    const byHunk = useCommit.getState().excludedHunkLines.get("/dev/acme-api/lines.txt");
    return [...(byHunk?.values() ?? [])].map((lines) => ({ old: [...lines.old], current: [...lines.current] }));
  });
  expect(excluded).toEqual([{ old: [1, 2], current: [0] }]);
  await page.mouse.move(end.x + 48, end.y + end.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 1, start.y + start.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(".cm-unified-commit-selected")).toHaveText(["old two", "old three", "new one"]);
  await old.click({ button: "right", position: { x: 16, y: 8 } });
  await menu.getByRole("menuitem", { name: "Include Selected Lines in Commit" }).click();
  await expect(marker).toBeChecked();
  await expect(marker).toHaveJSProperty("indeterminate", false);
});

test("a narrow diff keeps navigation, settings and the difference count visible", async ({ workbench: page }) => {
  const toolbar = await openChain(page);
  await page.setViewportSize({ width: 400, height: 600 });
  const clipped = await toolbar.evaluate((bar) => {
    const bounds = bar.getBoundingClientRect();
    const items = [...bar.querySelectorAll("button, span")].filter(
      (el) => el.matches("button") || el.textContent === "1 difference",
    );
    return items.flatMap((el) => {
      const box = el.getBoundingClientRect();
      if (el.matches("button") && !box.width) return [];
      return !box.width ||
        box.right > bounds.right + 1 ||
        box.bottom > bounds.bottom + 1 ||
        el.scrollWidth > el.clientWidth + 1
        ? [el.getAttribute("aria-label") || el.textContent]
        : [];
    });
  });
  expect(clipped).toEqual([]);
  await toolbar.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Unified Viewer", exact: true }).click();
  await expect(toolbar.locator("..").locator(".cm-editor")).toHaveCount(1);
  await toolbar.getByRole("button", { name: "Next Difference", exact: true }).click();
  await expect(toolbar).toContainText("1 of 1 differences");
});

test("revision titles keep both filenames in view when the diff divider moves", async ({ workbench: page }) => {
  const leftName = "OrderRoutes.ts";
  const rightName = "OrdersRoutes.ts";
  const directory = "services/customer-orders/fulfillment/warehouse-routing/primary";
  await page.setViewportSize({ width: 800, height: 650 });
  await stubDesktop(page);
  await page.evaluate(
    async ({ directory, leftName, rightName }) => {
      const inputPath = "/src/features/vcs/diffInput.ts";
      const layoutPath = "/src/workbench/toolwindows/store.ts";
      const { openDiff } = await import(inputPath);
      const { hideAllToolWindows } = await import(layoutPath);
      const leftPath = `/dev/acme-api/${directory}/${leftName}`;
      const rightPath = `/dev/acme-api/${directory}/${rightName}`;
      window.__ipc.handlers.vcs_file_at = (args) =>
        args.rev === "7b70e02c" ? "export const region = 'east';\r\n" : "export const region = 'west';\n";
      window.__ipc.handlers.vcs_file_mode = () => "100644";
      hideAllToolWindows();
      localStorage.setItem("openidea.vcs.diffOptions", JSON.stringify({ mode: "split", alignChanges: false }));
      await openDiff({
        path: rightPath,
        left: { type: "rev", rev: "7b70e02c", path: leftPath },
        right: { type: "rev", rev: "a8c5f31d", path: rightPath },
      });
    },
    { directory, leftName, rightName },
  );
  const left = page.getByTitle(/^7b70e02c .*OrderRoutes\.ts$/);
  const right = page.getByTitle(/^a8c5f31d .*OrdersRoutes\.ts$/);
  const filenamesFit = async () => {
    for (const [title, filename] of [
      [left, leftName],
      [right, rightName],
    ] as const) {
      await expect(title).toBeVisible();
      expect(await title.getAttribute("title")).toContain(`${directory}/${filename}`);
      const text = title.locator("span").filter({ hasText: filename }).last();
      expect(
        await text.evaluate((el, filename) => {
          const node = el.firstChild!;
          const range = document.createRange();
          range.setStart(node, (node.textContent ?? "").length - filename.length);
          range.setEnd(node, (node.textContent ?? "").length);
          const bounds = range.getBoundingClientRect();
          const clip = el.getBoundingClientRect();
          return bounds.left >= clip.left - 1 && bounds.right <= clip.right + 1;
        }, filename),
        `${filename} is visible within its revision label`,
      ).toBe(true);
    }
  };
  await filenamesFit();

  const divider = page.getByRole("separator", { name: "Resize diff panes" });
  const { x, y, width, height } = (await divider.boundingBox())!;
  const leftWidth = (await left.boundingBox())!.width;
  await page.mouse.move(x + width / 2, y + height / 2);
  await page.mouse.down();
  await page.mouse.move(x + width / 2 - 96, y + height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await left.boundingBox())!.width).toBeLessThan(leftWidth - 60);
  await filenamesFit();
});

test("a medium-width diff keeps its full status beside the viewer tools", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 490, height: 650 });
  await page.evaluate(async () => {
    const layoutPath = "/src/workbench/toolwindows/store.ts";
    const inputPath = "/src/features/vcs/diffInput.ts";
    const { hideAllToolWindows } = await import(layoutPath);
    const { openDiff, withChain } = await import(inputPath);
    hideAllToolWindows();
    localStorage.setItem("openidea.vcs.diffOptions", JSON.stringify({ mode: "split", collapse: false }));
    const files = ["a.ts", "b.ts"].map((name) => ({
      path: `/dev/acme-api/${name}`,
      left: { type: "text", text: "const rate = 0.05;\r\n", label: "Before" },
      right: { type: "text", text: "const rate = 0.05;\n", label: "After", editable: true },
    }));
    await openDiff(withChain(files, 0));
  });

  const toolbar = page.getByRole("toolbar", { name: "Diff", exact: true });
  const status = toolbar.getByText("Contents differ only in line separators", { exact: true });
  const settings = toolbar.getByRole("button", { name: "Settings", exact: true });
  await expect(status).toBeVisible();
  expect((await toolbar.boundingBox())!.width).toBeGreaterThan(380);
  await expect.poll(() => status.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThan(2);
  const message = (await status.boundingBox())!;
  const gear = (await settings.boundingBox())!;
  expect(gear.x).toBeGreaterThanOrEqual(message.x + message.width);
  expect(Math.abs(gear.y + gear.height / 2 - message.y - message.height / 2)).toBeLessThan(2);

  await expect(toolbar.getByRole("button", { name: "Compare Next File", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Unified Viewer", exact: true })).toBeHidden();
  await settings.click();
  await page.getByRole("menuitemcheckbox", { name: "Unified Viewer", exact: true }).click();
  await expect(toolbar.locator("..").locator(".cm-editor")).toHaveCount(1);
});

test("combined diff file actions stay visible beside a long name in a narrow pane", async ({ workbench: page }) => {
  const longName = "OrderHistoryCustomerNotificationDeliveryPreferencesValidationDefaults.txt";
  const directory = "/dev/acme-api/src/main/orders/preferences";
  await page.evaluate(
    async (paths) => {
      const optionsPath = "/src/features/vcs/allInOneDiff.ts";
      const inputPath = "/src/features/vcs/diffInput.ts";
      const { setAllInOneDiff } = await import(optionsPath);
      const { openDiff, withChain } = await import(inputPath);
      setAllInOneDiff(true);
      await openDiff(
        withChain(
          paths.map((path) => ({
            path,
            left: { type: "text", text: "before\n", label: "HEAD" },
            right: { type: "worktree" },
          })),
          0,
        ),
      );
    },
    [`${directory}/${longName}`, `${directory}/Notes.txt`],
  );
  await page.setViewportSize({ width: 460, height: 600 });

  const file = page.getByRole("region", { name: longName, exact: true });
  const header = file.getByRole("button", { name: /^(Collapse|Expand) File$/ }).locator("..");
  const open = header.getByRole("button", { name: "Open in Separate Tab", exact: true });
  const jump = header.getByRole("button", { name: "Jump to Source", exact: true });
  await expect(open).toBeInViewport({ ratio: 1 });
  await expect(jump).toBeInViewport({ ratio: 1 });
  const label = header.getByText(longName, { exact: true });
  await expect(label).toHaveCSS("text-overflow", "ellipsis");
  const labelBox = (await label.boundingBox())!;
  const jumpBox = (await jump.boundingBox())!;
  expect(labelBox.x).toBeGreaterThan(jumpBox.x + jumpBox.width);
  await expect(header).toContainText("src/main/orders/preferences");

  await header.getByRole("button", { name: "Collapse File", exact: true }).click();
  await expect(file.getByRole("button", { name: "Expand File", exact: true })).toBeVisible();
  await open.click();
  await expect(page.getByRole("tab", { name: new RegExp(longName), selected: true })).toBeVisible();
});

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
