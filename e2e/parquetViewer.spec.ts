import { expect, stubDesktop, test } from "./fixtures";

test("opens a Parquet preview, pages through rows, and inspects schema and values", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const path = "/dev/acme-api/events.parquet";
    window.__ipc.handlers.fs_read_parquet = ({ path: requested, offset }) => {
      if (requested !== path) throw new Error("Unexpected Parquet path");
      return {
        columns: [
          { name: "sequence", dataType: "UInt64", nullable: false },
          { name: "tags", dataType: "List(Utf8)", nullable: true },
        ],
        rows:
          offset === 0
            ? [
                ["9007199254740993", "[abc, def]"],
                ["9007199254740994", null],
              ]
            : [["9007199254740995", "[]"]],
        totalRows: 3,
        rowGroups: 2,
        pageSize: 2,
        size: 1024,
        compression: ["ZSTD"],
      };
    };
    const workbench = "/src/workbench/contributions.ts";
    const { editorService } = await import(/* @vite-ignore */ workbench);
    await editorService().openFile(path, { focus: true });
  });

  const rows = page.getByRole("table", { name: "Parquet rows" });
  await expect(rows.getByRole("columnheader", { name: "sequence" })).toBeVisible();
  await expect(rows.getByText("9007199254740993")).toBeVisible();
  await expect(rows.getByText("NULL", { exact: true })).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "Parquet preview" })).toContainText("2 row groups");
  await rows.getByRole("button", { name: "[abc, def]", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Value in tags" })).toContainText("[abc, def]");
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).last().click();

  await page.getByRole("button", { name: "Next page" }).click();
  await expect(rows.getByText("9007199254740995")).toBeVisible();
  await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();
  await page.getByRole("button", { name: "Previous page" }).click();
  await expect(rows.getByText("9007199254740993")).toBeVisible();
  await page.getByRole("button", { name: "Schema", exact: true }).click();
  const schema = page.getByRole("table", { name: "Schema" });
  await expect(schema.getByRole("row").filter({ hasText: "sequence" })).toContainText("UInt64");
  await expect(schema.getByRole("row").filter({ hasText: "tags" })).toContainText("List(Utf8)");
  const offsets = await page.evaluate(() =>
    window.__ipc.calls.filter(({ cmd }) => cmd === "fs_read_parquet").map(({ args }) => args.offset),
  );
  expect(offsets.filter((offset, index) => index === 0 || offset !== offsets[index - 1])).toEqual([0, 2, 0]);
});
