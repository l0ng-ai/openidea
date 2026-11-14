import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const expected =
  '[\n  {\n    "id": 9223372036854775807,\n    "amount": 1.0000000000000000002,\n    "note": "9007199254740993",\n    "empty": null\n  }\n]';

async function seedResult(page: Page) {
  await stubDesktop(page);
  await page.evaluate(async () => {
    window.__ipc.handlers.clipboard_write_text = () => null;
    window.__ipc.handlers.db_export_file = () => null;
    window.__ipc.handlers["plugin:path|resolve_directory"] = () => "/tmp";
    const storePath = "/src/features/database/store.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { useDatabase, RESULTS_VIEW } = await import(storePath);
    const { showServiceView } = await import(contributionsPath);
    const text = "SELECT id, amount, note, empty FROM numbers";
    useDatabase.setState({
      loaded: true,
      sources: [{ id: "exact", name: "Exact numbers", driver: "postgres", readOnly: true }],
      consoles: { "exact-console.sql": "exact" },
      results: [
        {
          id: 1,
          title: "Result 1",
          path: "exact-console.sql",
          sourceId: "exact",
          outcome: {
            statement: { text, from: 0, to: text.length },
            error: null,
            result: {
              statement: text,
              columns: [
                { name: "id", typeName: "BIGINT" },
                { name: "amount", typeName: "NUMERIC(38,19)" },
                { name: "note", typeName: "TEXT" },
                { name: "empty", typeName: "TEXT" },
              ],
              rows: [["9223372036854775807", "1.0000000000000000002", "9007199254740993", null]],
              affected: null,
              hasMore: false,
              elapsedMs: 1,
              executionMs: 1,
            },
          },
          page: 0,
          pageSize: 500,
        },
      ],
      activeResult: 1,
    });
    showServiceView(RESULTS_VIEW);
  });
  await expect(page.getByRole("grid", { name: "Result 1", exact: true }).getByRole("gridcell")).toHaveCount(4);
}

async function openExport(page: Page) {
  await page.getByRole("button", { name: "Export Data", exact: true }).click();
  await page.getByRole("menuitem", { name: "Export Data…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export Data", exact: true });
  await dialog.getByRole("button", { name: "Extractor", exact: true }).click();
  await page.getByRole("option", { name: "JSON", exact: true }).click();
  return dialog;
}

test("Copy as JSON preserves exact numeric values", async ({ workbench: page }) => {
  await seedResult(page);
  await page.getByRole("button", { name: "Export Data", exact: true }).click();
  await page.getByRole("menuitem", { name: "Copy as JSON", exact: true }).click();
  await expect.poll(() => ipcCalls(page, "clipboard_write_text")).toHaveLength(1);
  expect((await ipcCalls(page, "clipboard_write_text"))[0]!.text).toBe(expected);
});

test("Export Data preserves exact preview and clipboard values", async ({ workbench: page }) => {
  await seedResult(page);
  const dialog = await openExport(page);
  await expect(dialog.getByLabel("Export preview", { exact: true })).toHaveText(expected);
  await dialog.getByRole("button", { name: "Copy to Clipboard", exact: true }).click();
  await expect.poll(() => ipcCalls(page, "clipboard_write_text")).toHaveLength(1);
  expect((await ipcCalls(page, "clipboard_write_text"))[0]!.text).toBe(expected);
});

test("Export Data preserves exact preview and exported file values", async ({ workbench: page }) => {
  await seedResult(page);
  const dialog = await openExport(page);
  await expect(dialog.getByLabel("Export preview", { exact: true })).toHaveText(expected);
  await dialog.getByRole("textbox", { name: "Output file", exact: true }).fill("/tmp/exact-numbers.json");
  await dialog.getByRole("button", { name: "Export to File", exact: true }).click();
  await expect.poll(() => ipcCalls(page, "db_export_file")).toHaveLength(1);
  expect((await ipcCalls(page, "db_export_file"))[0]).toEqual({ path: "/tmp/exact-numbers.json", text: expected });
});
