import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerAction } from "@/platform/actions";
import { copyImageAction } from "./imageActions";
import { ImageStrip } from "./ImageStrip";

const mocks = vi.hoisted(() => ({ write: vi.fn().mockResolvedValue(undefined), menu: vi.fn(), notify: vi.fn() }));
vi.mock("@/platform/clipboard", () => ({ writeClipboardPng: mocks.write }));
vi.mock("@/workbench/contributions", () => ({ notifications: () => ({ notify: mocks.notify }) }));
vi.mock("@/ui", async (original) => ({ ...(await original<typeof import("@/ui")>()), showContextMenu: mocks.menu }));
const image = { mimeType: "image/png", data: "iVBORw0KGgo=", name: "preview.png" };
let dispose: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  dispose = registerAction(copyImageAction);
});
afterEach(() => {
  dispose();
  vi.useRealTimers();
});

it("offers Copy Image on thumbnail right-click without opening the preview", () => {
  render(<ImageStrip images={[image]} />);
  fireEvent.contextMenu(screen.getByRole("img"));
  expect(mocks.menu).toHaveBeenCalledWith(expect.anything(), [
    { kind: "action", action: "agents.copyImage", arg: { image } },
  ]);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("keeps macOS Control-click available for the context menu without opening the image", () => {
  render(<ImageStrip images={[image]} />);
  fireEvent.click(screen.getByRole("img"), { button: 0, ctrlKey: true });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.contextMenu(screen.getByRole("img"), { ctrlKey: true });
  expect(mocks.menu).toHaveBeenCalledOnce();
});

it("copies from the full preview and confirms success without closing it", async () => {
  vi.useFakeTimers();
  render(<ImageStrip images={[image]} />);
  fireEvent.click(screen.getByRole("img"));
  const dialog = screen.getByRole("dialog", { name: "preview.png" });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy Image" })));
  expect(mocks.write).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  expect(dialog).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.getByRole("button", { name: "Copy Image" })).toBeInTheDocument();
  fireEvent.contextMenu(dialog.querySelector("img")!);
  expect(mocks.menu).toHaveBeenCalledWith(expect.anything(), [
    expect.objectContaining({ action: "agents.copyImage", arg: expect.objectContaining({ image }) }),
  ]);
});

it("leaves the copy action available for retry after native clipboard failure", async () => {
  mocks.write.mockRejectedValueOnce(new Error("denied"));
  render(<ImageStrip images={[image]} />);
  fireEvent.click(screen.getByRole("img"));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy Image" })));
  expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();
  expect(mocks.notify).toHaveBeenCalledOnce();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy Image" })));
  expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
});
