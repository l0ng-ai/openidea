import type { Locator } from "@playwright/test";
import { expect, stubDesktop, test } from "./fixtures";

async function expectAligned(grid: Locator, names: string[]) {
  await expect(grid.getByRole("columnheader")).toHaveText(names);
  await expect
    .poll(() =>
      grid.evaluate((element) => {
        const head = [...element.querySelectorAll('[role="columnheader"]')].filter(
          (cell) => cell.getClientRects().length,
        );
        const row = element.querySelector('[aria-rowindex="2"]');
        const cells = [...(row?.querySelectorAll('[role="gridcell"]') ?? [])].filter(
          (cell) => cell.getClientRects().length,
        );
        return (
          cells.length === head.length &&
          head.every((cell, index) => {
            const header = cell.getBoundingClientRect();
            const value = cells[index]!.getBoundingClientRect();
            return Math.abs(header.x - value.x) < 1 && Math.abs(header.width - value.width) < 1;
          })
        );
      }),
    )
    .toBe(true);
}

test("directory comparison mirrors both sides and keeps the headers aligned while the list scrolls", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1220, height: 780 });
  await stubDesktop(page);
  await page.evaluate(async () => {
    const entry = {
      leftKind: "file",
      rightKind: "file",
      status: "different",
      leftSize: 120,
      rightSize: 144,
      leftModified: Date.UTC(2026, 9, 8, 12),
      rightModified: Date.UTC(2026, 9, 9, 12),
    };
    const handlers = window.__ipc.handlers;
    handlers.fs_entry_kind = ({ path }) => (String(path).endsWith(".txt") ? "file" : "dir");
    handlers.cancel_request = () => null;
    handlers.fs_read_text = () => "";
    handlers.fs_compare_directories = () => [
      { ...entry, path: "00-configuration.txt" },
      ...Array.from({ length: 65 }, (_, index) => ({ ...entry, path: `log-${index}.txt` })),
      { ...entry, path: "only-left.txt", rightKind: null, rightSize: null, status: "leftOnly" },
      { ...entry, path: "shared.txt", status: "equal" },
    ];
    const actions = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actions);
    await executeAction("toolwindow.hideAll");
    await executeAction("diff.compareDirectories", ["/dev/acme-api/source", "/dev/acme-api/target"]);
  });

  const grid = page.getByRole("grid", { name: "Compared files" });
  const filter = page.getByRole("textbox", { name: "Filter by name" });
  const source = page.getByRole("textbox", { name: "Left folder" });
  const target = page.getByRole("textbox", { name: "Right folder" });
  await expect(source).toHaveValue("/dev/acme-api/source");
  await expect(target).toHaveValue("/dev/acme-api/target");
  const [pathBox, filterBox] = await Promise.all([source.boundingBox(), filter.boundingBox()]);
  if (!pathBox || !filterBox) throw new Error("Missing comparison toolbar bounds");
  expect(pathBox.y).toBeGreaterThanOrEqual(filterBox.y + filterBox.height);
  await expectAligned(grid, ["Name", "Size", "Date", "", "Date", "Size", "Name"]);
  const first = grid.getByRole("row").filter({ has: page.getByRole("gridcell", { name: "00-configuration.txt" }) });
  const values = await first.getByRole("gridcell").allTextContents();
  expect(values.at(0)).toBe("00-configuration.txt");
  expect(values.at(1)).toBe("120 B");
  expect(values.at(-2)).toBe("144 B");
  expect(values.at(-1)).toBe("00-configuration.txt");
  const rows = grid.locator('[role="rowgroup"][tabindex="0"]');
  expect(await rows.evaluate((el) => el.scrollHeight)).toBeGreaterThan(await rows.evaluate((el) => el.clientHeight));

  await page.setViewportSize({ width: 630, height: 740 });
  await expectAligned(grid, ["Name", "Size", "", "Size", "Name"]);
  await expect(first.getByRole("gridcell").first()).toHaveAttribute("title", /00-configuration.txt.*120 B/);
  const setContainerType = (value: string) =>
    filter.evaluate((el, type) => {
      const container = el.parentElement?.parentElement;
      if (!container) throw new Error("Missing directory comparison container");
      container.style.containerType = type;
    }, value);
  await setContainerType("normal");
  await expectAligned(grid, ["Name", "Size", "Date", "", "Date", "Size", "Name"]);
  await expect(first.getByRole("gridcell").first()).toBeInViewport({ ratio: 1 });
  await setContainerType("");
  await page.setViewportSize({ width: 360, height: 740 });
  await expectAligned(grid, ["Name", "", "Name"]);

  await page.setViewportSize({ width: 630, height: 740 });
  await filter.fill("shared");
  await expect(page.getByText("No matching differences", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show identical files" }).click();
  const shared = grid.getByRole("gridcell", { name: "shared.txt", exact: true });
  await expect(shared).toHaveCount(2);
  await shared.first().click();
  // An identical file's row does nothing by default, so there is nothing to synchronize.
  await expect(page.getByRole("button", { name: "Synchronize Selected", exact: true })).toBeDisabled();
  await expect(page.getByRole("toolbar", { name: "Diff", exact: true })).toBeVisible();
});
