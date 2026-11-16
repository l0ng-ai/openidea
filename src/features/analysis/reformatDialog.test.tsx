import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AnalysisDialogHost } from "./dialogs";
import { showReformatCodeDialog } from "./AnalysisDialogs";

const mocks = vi.hoisted(() => ({ runReformat: vi.fn() }));
vi.mock("./cleanup", async (original) => ({
  ...(await original<typeof import("./cleanup")>()),
  runReformat: mocks.runReformat,
}));

afterEach(() => {
  cleanup();
  mocks.runReformat.mockReset();
});

it("runs Reformat Code on a directory with the chosen options", () => {
  render(<AnalysisDialogHost />);
  act(() => void showReformatCodeDialog([{ path: "/p/bin", dir: true }]));
  expect(screen.getByRole("checkbox", { name: "Include subdirectories" })).toBeChecked();
  const mask = screen.getByRole("textbox", { name: "File mask" });
  expect(mask).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "File mask:" }));
  fireEvent.change(mask, { target: { value: "*.sh" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Include subdirectories" }));
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(mocks.runReformat).toHaveBeenCalledWith([{ path: "/p/bin", dir: true }], {
    recursive: false,
    optimizeImports: false,
    mask: "*.sh",
    changedTextOnly: false,
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("offers Include subdirectories only when a directory is chosen", () => {
  render(<AnalysisDialogHost />);
  act(
    () =>
      void showReformatCodeDialog([
        { path: "/p/a.sh", dir: false },
        { path: "/p/b.sh", dir: false },
      ]),
  );
  expect(screen.queryByRole("checkbox", { name: "Include subdirectories" })).toBeNull();
  expect(screen.getByText("2 selected items")).toBeTruthy();
});
