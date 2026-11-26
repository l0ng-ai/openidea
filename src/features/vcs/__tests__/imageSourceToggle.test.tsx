import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ResolvedDiffEditor } from "../DiffEditor";
import { diffInput, type DiffData } from "../diffInput";

vi.mock("../ImageDiffHost", () => ({
  ImageDiffHost: ({ onSource }: { onSource: () => void }) => <button onClick={onSource}>View source diff</button>,
}));
vi.mock("../StagingDiff", () => ({
  StagingDiff: ({ toolbarActions }: { toolbarActions: ReactNode }) => (
    <>
      {toolbarActions}
      <textarea aria-label="index" />
    </>
  ),
}));
afterEach(cleanup);

it("keeps the SVG source editor and its pending index edits alive while previewing the image", () => {
  const data: DiffData = {
    path: "/repo/icon.svg",
    left: { type: "rev", rev: "HEAD" },
    middle: { type: "rev", rev: ":0" },
    right: { type: "worktree" },
  };
  render(
    <ResolvedDiffEditor input={diffInput(data)} diff={{ data, entries: null, versions: undefined, loading: false }} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "View source diff" }));
  const index = screen.getByRole("textbox", { name: "index" });
  fireEvent.change(index, { target: { value: "<svg/>" } });
  fireEvent.click(screen.getByRole("button", { name: "Image preview" }));
  expect(index).toBeInTheDocument();
  expect(index).not.toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "View source diff" }));
  expect(screen.getByRole("textbox", { name: "index" })).toHaveValue("<svg/>");
});
