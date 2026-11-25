import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeClipboardText } from "@/platform/clipboard";
import { commands } from "@/platform/ipc";
import { ExportDialog } from "./ExportDialog";
import { cellPreview } from "./cellPreview";

vi.mock("@/platform/clipboard", () => ({ writeClipboardText: vi.fn(async () => {}) }));
vi.mock("./store", () => ({ closeDialog: vi.fn() }));
vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify: vi.fn() }),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/home/test" }));

afterEach(() => vi.restoreAllMocks());

describe("large value export", () => {
  it("bounds preview values while exporting every row in full", async () => {
    const full = JSON.stringify({ text: "\u4e2d text ".repeat(200_000), tail: "complete" });
    const dbExportFile = vi.spyOn(commands, "dbExportFile").mockResolvedValue({ status: "ok", data: null });
    const rows = [[full], ["short"], [null]];
    render(
      <ExportDialog
        data={{ columns: [{ name: "payload", type: "jsonb" }], rows, table: "big", driver: "postgres" }}
        source="public.big"
        initialFormat="json"
      />,
    );
    const preview = screen.getByLabelText("Export preview");
    expect(JSON.parse(preview.textContent!)).toEqual([
      { payload: cellPreview(full) },
      { payload: "short" },
      { payload: null },
    ]);
    await waitFor(() => expect(screen.getByLabelText("Output file")).toHaveValue("/home/test/big.json"));
    fireEvent.click(screen.getByRole("button", { name: "Export to File" }));
    await waitFor(() => expect(dbExportFile).toHaveBeenCalled());
    const [path, contents] = dbExportFile.mock.calls[0]!;
    expect(path).toBe("/home/test/big.json");
    expect(JSON.parse(contents)).toEqual(rows.map(([payload]) => ({ payload })));
    dbExportFile.mockRestore();
  });
});

describe("exact numeric export", () => {
  it.each(["Copy to Clipboard", "Export to File"])("keeps preview and %s values exact", async (action) => {
    const dbExportFile = vi.spyOn(commands, "dbExportFile").mockResolvedValue({ status: "ok", data: null });
    vi.mocked(writeClipboardText).mockClear();
    const expected =
      '[\n  {\n    "id": 9223372036854775807,\n    "amount": 1.0000000000000000002,\n    "note": "9007199254740993",\n    "empty": null\n  }\n]';
    render(
      <ExportDialog
        data={{
          columns: [
            { name: "id", type: "BIGINT" },
            { name: "amount", type: "NUMERIC(38,19)" },
            { name: "note", type: "TEXT" },
            { name: "empty", type: "TEXT" },
          ],
          rows: [["9223372036854775807", "1.0000000000000000002", "9007199254740993", null]],
          table: "numbers",
          driver: "postgres",
        }}
        source="public.numbers"
        initialFormat="json"
      />,
    );
    expect(screen.getByLabelText("Export preview").textContent).toBe(expected);
    await waitFor(() => expect(screen.getByLabelText("Output file")).toHaveValue("/home/test/numbers.json"));
    fireEvent.click(screen.getByRole("button", { name: action }));
    if (action === "Copy to Clipboard") {
      await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith(expected));
    } else {
      await waitFor(() => expect(dbExportFile).toHaveBeenCalledWith("/home/test/numbers.json", expected));
    }
  });
});

it.each(["Copy to Clipboard", "Export to File"])(
  "%s includes numeric rows beyond the preview limit",
  async (action) => {
    const dbExportFile = vi.spyOn(commands, "dbExportFile").mockResolvedValue({ status: "ok", data: null });
    vi.mocked(writeClipboardText).mockClear();
    const rows = Array.from({ length: 101 }, (_, i) => [(9223372036854775807n - BigInt(i)).toString()]);
    render(
      <ExportDialog
        data={{ columns: [{ name: "id", type: "BIGINT" }], rows, table: "numbers", driver: "postgres" }}
        source="public.numbers"
        initialFormat="json"
      />,
    );
    const preview = screen.getByLabelText("Export preview").textContent!;
    expect(preview).toContain('"id": 9223372036854775807');
    expect(preview).not.toContain(rows[100]![0]!);
    expect(preview).toContain("… 1 more rows");
    await waitFor(() => expect(screen.getByLabelText("Output file")).toHaveValue("/home/test/numbers.json"));
    fireEvent.click(screen.getByRole("button", { name: action }));
    let text: string;
    if (action === "Copy to Clipboard") {
      await waitFor(() => expect(writeClipboardText).toHaveBeenCalled());
      text = vi.mocked(writeClipboardText).mock.calls[0]![0];
    } else {
      await waitFor(() => expect(dbExportFile).toHaveBeenCalled());
      text = dbExportFile.mock.calls[0]![1];
    }
    expect(JSON.parse(text)).toHaveLength(101);
    expect(text).toContain(`"id": ${rows[100]![0]}`);
  },
);
