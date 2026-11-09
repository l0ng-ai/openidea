import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { commands } from "@/platform/ipc";
import { ExportDialog } from "./ExportDialog";
import { cellPreview } from "./cellPreview";

vi.mock("./store", () => ({ closeDialog: vi.fn() }));
vi.mock("@/workbench/contributions", () => ({ notifications: () => ({ notify: vi.fn() }) }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/home/test" }));

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
